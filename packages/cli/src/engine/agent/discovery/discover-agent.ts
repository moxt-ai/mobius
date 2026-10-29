import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { ProcessExecutionError } from "../../util/process/executable.ts";
import { InProcessAcpAgentSpecification, type LocalAgentSpecification } from "../specification/agent-specification.ts";
import { probeAcpReadiness } from "./acp-readiness-probe.ts";
import {
    type AgentDiscovery,
    AgentProbeFailed,
    AuthenticationRequiredAgent,
    AvailableAgent,
    IncompatibleAdapter,
    IntegrationProbeFailed,
    MissingAdapter,
    MissingAgent,
    type UnavailableAgent,
    UnsupportedAgentVersion,
} from "./agent-discovery.ts";
import type { AgentProbeDiagnostic, LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import { isAgentVersionSupported } from "./agent-version.ts";
import { probeVersion, resolveAdapterExecutables, resolveAgentExecutables } from "./executable-discovery.ts";

function agentProbeFailure(specification: LocalAgentSpecification, error: unknown): UnavailableAgent {
    if (error instanceof AgentProbeError) {
        return new AgentProbeFailed(specification, error.code, error.message);
    }
    if (error instanceof ProcessExecutionError) {
        const code = error.code === "process_timeout" ? "agent_probe_timeout" : "agent_probe_failed";
        return new AgentProbeFailed(specification, code, "Agent version probe failed");
    }
    return new AgentProbeFailed(specification, "agent_probe_failed", "Agent probe failed");
}

// A timeout says the probe lost a race, not that the Agent is absent or broken. Discovery runs while
// the host is doing other work, so reclassifying a healthy Agent as missing on one slow probe would
// silently drop it from the catalog. Retry the same probe once before reporting a failure; every
// other failure kind is deterministic and is reported immediately.
function isRetryableProbeFailure(error: unknown): boolean {
    if (error instanceof ProcessExecutionError) {
        return error.code === "process_timeout";
    }
    return error instanceof AgentProbeError && error.code === "adapter_probe_timeout";
}

async function probeWithRetry<Value>(
    context: LocalAgentDiscoveryContext,
    specification: LocalAgentSpecification,
    source: AgentProbeDiagnostic["source"],
    probe: () => Promise<Value>,
): Promise<Value> {
    const signal = context.signal;
    const run = async (attempt: number): Promise<Value> => {
        const startedAt = performance.now();
        try {
            return await probe();
        } catch (failure) {
            context.onProbeDiagnostic?.({
                agentId: specification.id,
                source,
                event: signal.aborted ? "agent_probe_cancelled" : "agent_probe_failed",
                attempt,
                elapsedMilliseconds: Math.round(performance.now() - startedAt),
                timeoutMilliseconds:
                    source === "acp_readiness"
                        ? specification.acpProbeTimeoutMilliseconds
                        : specification.versionProbeTimeoutMilliseconds,
                failure,
            });
            throw failure;
        }
    };
    try {
        return await run(1);
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (!isRetryableProbeFailure(error)) {
            throw error;
        }
        return await run(2);
    }
}

function integrationProbeFailure(specification: LocalAgentSpecification, error: unknown): UnavailableAgent {
    if (error instanceof AgentProbeError) {
        if (error.code === "authentication_required") {
            return new AuthenticationRequiredAgent(specification);
        }
        return error.code === "acp_incompatible"
            ? new IncompatibleAdapter(specification, error.message)
            : new IntegrationProbeFailed(specification, error.code, error.message);
    }
    if (error instanceof ProcessExecutionError) {
        const code = error.code === "process_timeout" ? "adapter_probe_timeout" : "adapter_probe_failed";
        return new IntegrationProbeFailed(specification, code, "Adapter version probe failed");
    }
    return new IntegrationProbeFailed(specification, "adapter_probe_failed", "Adapter probe failed");
}

export async function discoverAgent(
    specification: LocalAgentSpecification,
    context: LocalAgentDiscoveryContext,
): Promise<AgentDiscovery> {
    context.signal.throwIfAborted();
    const [adapters, agents] = await Promise.all([
        resolveAdapterExecutables(specification, context),
        resolveAgentExecutables(specification, context),
    ]);
    if (agents.length === 0) {
        return new MissingAgent(specification);
    }

    let lastFailure: UnavailableAgent | null = null;
    for (const agent of agents) {
        let agentVersion = "";
        try {
            agentVersion = await probeWithRetry(
                context,
                specification,
                "agent_version",
                async () =>
                    await probeVersion(
                        agent,
                        specification.agentVersionArguments,
                        context.environment,
                        context.defaultWorkspace,
                        context.signal,
                        specification.versionProbeTimeoutMilliseconds,
                        specification.normalizeAgentVersion,
                    ),
            );
        } catch (error) {
            if (context.signal.aborted) {
                context.signal.throwIfAborted();
            }
            lastFailure = agentProbeFailure(specification, error);
            continue;
        }
        const supportedVersion = isAgentVersionSupported(agentVersion, specification.minimumSupportedAgentVersion);
        if (supportedVersion === null) {
            lastFailure = new AgentProbeFailed(
                specification,
                "agent_probe_failed",
                "Agent reported an unrecognized version",
            );
            continue;
        }
        if (!supportedVersion) {
            lastFailure = new UnsupportedAgentVersion(
                specification,
                agentVersion,
                specification.minimumSupportedAgentVersion,
            );
            continue;
        }
        // An in-process Agent is its own adapter: `resolveAdapterExecutables` already returned the
        // Agent executable, so an empty adapter list never means "install an adapter" here.
        if (adapters.length === 0 && !(specification instanceof InProcessAcpAgentSpecification)) {
            return new MissingAdapter(specification);
        }

        for (const adapter of adapters) {
            if (adapter.path !== agent.path) {
                continue;
            }
            let adapterVersion = "";
            let launchEnvironment: Readonly<Record<string, string>>;
            try {
                launchEnvironment = await specification.createLaunchEnvironment(agent, context);
                if (specification.adapterVersionArguments.length > 0) {
                    adapterVersion = await probeWithRetry(
                        context,
                        specification,
                        "adapter_version",
                        async () =>
                            await probeVersion(
                                adapter,
                                specification.adapterVersionArguments,
                                {
                                    ...context.environment,
                                    ...launchEnvironment,
                                },
                                context.defaultWorkspace,
                                context.signal,
                                specification.versionProbeTimeoutMilliseconds,
                                specification.normalizeAdapterVersion,
                            ),
                    );
                }
            } catch (error) {
                if (context.signal.aborted) {
                    context.signal.throwIfAborted();
                }
                lastFailure = integrationProbeFailure(specification, error);
                continue;
            }

            const buildDefinition = (
                verifiedAdapterVersion: string,
                capabilities: SessionCapabilities,
            ): AcpAgentDefinition =>
                new AcpAgentDefinition(
                    specification.id,
                    specification.label,
                    agent.path,
                    specification.createConnection,
                    launchEnvironment,
                    agentVersion.length > 0 ? agentVersion : verifiedAdapterVersion,
                    agent.identity,
                    capabilities,
                    specification instanceof InProcessAcpAgentSpecification ? agentVersion : verifiedAdapterVersion,
                );
            try {
                const readiness = await probeWithRetry(
                    context,
                    specification,
                    "acp_readiness",
                    async () =>
                        await probeAcpReadiness(
                            specification,
                            buildDefinition(adapterVersion, unsupportedSessionCapabilities()),
                            context.environment,
                            context.defaultWorkspace,
                            context.signal,
                        ),
                );
                const verifiedAdapterVersion = adapterVersion.length > 0 ? adapterVersion : readiness.adapterVersion;
                if (verifiedAdapterVersion.length === 0) {
                    throw new AgentProbeError("acp_incompatible", "ACP adapter did not report a version");
                }
                return new AvailableAgent(
                    specification,
                    buildDefinition(verifiedAdapterVersion, readiness.capabilities),
                );
            } catch (error) {
                if (context.signal.aborted) {
                    context.signal.throwIfAborted();
                }
                const failure = integrationProbeFailure(specification, error);
                if (failure instanceof AuthenticationRequiredAgent) {
                    return failure;
                }
                lastFailure = failure;
            }
        }
    }
    return lastFailure ?? new MissingAgent(specification);
}
