import type { SessionCapabilities } from "@moxt-ai/mobius-protocol";
import { unsupportedSessionCapabilities } from "../acp/session-capabilities.ts";
import { ProcessExecutionError } from "../util/process/executable.ts";
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
    type UnavailableInstalledAgent,
    UnsupportedAgentVersion,
} from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import {
    DirectAcpAgentDefinition,
    InProcessAcpAgentDefinition,
    type LocalAgentSpecification,
} from "./agent-specification.ts";
import { isAgentVersionSupported } from "./agent-version.ts";
import { probeVersion, resolveAdapterExecutables, resolveAgentExecutables } from "./executable-discovery.ts";

import {
    type AcpAgentDefinition,
    AgentIntegrationDefinition,
    InProcessAcpAgentDefinition as InProcessAgentDefinition,
    LocalAgentDefinition,
} from "./local-agent.ts";

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

async function probeWithRetry<Value>(signal: AbortSignal, probe: () => Promise<Value>): Promise<Value> {
    try {
        return await probe();
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (!isRetryableProbeFailure(error)) {
            throw error;
        }
        return await probe();
    }
}

function integrationProbeFailure(
    specification: LocalAgentSpecification,
    agent: AgentIntegrationDefinition,
    error: unknown,
): UnavailableInstalledAgent {
    if (error instanceof AgentProbeError) {
        if (error.code === "authentication_required") {
            return new AuthenticationRequiredAgent(specification, agent);
        }
        return error.code === "acp_incompatible"
            ? new IncompatibleAdapter(specification, agent, error.message)
            : new IntegrationProbeFailed(specification, agent, error.code, error.message);
    }
    if (error instanceof ProcessExecutionError) {
        const code = error.code === "process_timeout" ? "adapter_probe_timeout" : "adapter_probe_failed";
        return new IntegrationProbeFailed(specification, agent, code, "Adapter version probe failed");
    }
    return new IntegrationProbeFailed(specification, agent, "adapter_probe_failed", "Adapter probe failed");
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
                context.signal,
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
        const installedAgent = new AgentIntegrationDefinition(
            specification.id,
            specification.label,
            agent.identity.requestedPath,
            agentVersion,
        );
        if (!supportedVersion) {
            lastFailure = new UnsupportedAgentVersion(
                specification,
                installedAgent,
                specification.minimumSupportedAgentVersion,
            );
            continue;
        }
        // An in-process Agent is its own adapter: `resolveAdapterExecutables` already returned the
        // Agent executable, so an empty adapter list never means "install an adapter" here.
        if (adapters.length === 0 && !(specification instanceof InProcessAcpAgentDefinition)) {
            return new MissingAdapter(specification, installedAgent);
        }

        for (const adapter of adapters) {
            if (specification instanceof DirectAcpAgentDefinition && adapter.path !== agent.path) {
                continue;
            }
            let adapterVersion = "";
            let launchEnvironment: Readonly<Record<string, string>>;
            try {
                launchEnvironment = await specification.createLaunchEnvironment(agent, context);
                if (specification.adapterVersionArguments.length > 0) {
                    adapterVersion = await probeWithRetry(
                        context.signal,
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
                lastFailure = integrationProbeFailure(specification, installedAgent, error);
                continue;
            }

            const buildDefinition = (
                verifiedAdapterVersion: string,
                capabilities: SessionCapabilities,
            ): AcpAgentDefinition =>
                specification instanceof InProcessAcpAgentDefinition
                    ? new InProcessAgentDefinition(
                          specification.id,
                          specification.label,
                          agent.path,
                          specification.createEndpoint,
                          launchEnvironment,
                          agentVersion.length > 0 ? agentVersion : verifiedAdapterVersion,
                          agent.identity,
                          capabilities,
                      )
                    : new LocalAgentDefinition(
                          specification.id,
                          specification.label,
                          adapter.path,
                          specification.launchArguments,
                          launchEnvironment,
                          verifiedAdapterVersion,
                          agentVersion,
                          adapter.identity,
                          agent.identity,
                          capabilities,
                      );
            try {
                const readiness = await probeWithRetry(
                    context.signal,
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
                const failure = integrationProbeFailure(specification, installedAgent, error);
                if (failure instanceof AuthenticationRequiredAgent) {
                    return failure;
                }
                lastFailure = failure;
            }
        }
    }
    return lastFailure ?? new MissingAgent(specification);
}
