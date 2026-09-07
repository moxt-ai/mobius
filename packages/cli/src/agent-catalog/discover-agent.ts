import { ProcessExecutionError } from "../process/executable.ts";
import { probeAcpReadiness } from "./acp-readiness-probe.ts";
import {
  type AgentDiscovery,
  AuthenticationRequiredAgent,
  AvailableAgent,
  IncompatibleAdapter,
  MissingAdapter,
  MissingAgent,
  ProbeFailed,
  type UnavailableAgent,
} from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import {
  DirectAcpAgentDefinition,
  type LocalAgentSpecification,
} from "./agent-specification.ts";
import {
  probeVersion,
  resolveAdapterExecutables,
  resolveAgentExecutables,
} from "./executable-discovery.ts";
import { LocalAgentDefinition } from "./local-agent.ts";

function probeFailure(
  specification: LocalAgentSpecification,
  executableKind: string,
  error: unknown,
): UnavailableAgent {
  if (error instanceof AgentProbeError) {
    if (error.code === "authentication_required") {
      return new AuthenticationRequiredAgent(specification);
    }
    return error.code === "acp_incompatible"
      ? new IncompatibleAdapter(specification)
      : new ProbeFailed(specification, error.code, error.message);
  }
  if (error instanceof ProcessExecutionError) {
    const code =
      error.code === "process_timeout"
        ? `${executableKind}_probe_timeout`
        : `${executableKind}_probe_failed`;
    return new ProbeFailed(
      specification,
      code,
      `${executableKind === "agent" ? "Agent" : "Adapter"} version probe failed`,
    );
  }
  return new ProbeFailed(
    specification,
    `${executableKind}_probe_failed`,
    `${executableKind === "agent" ? "Agent" : "Adapter"} probe failed`,
  );
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
  if (
    specification instanceof DirectAcpAgentDefinition &&
    agents.length === 0
  ) {
    return new MissingAgent(specification);
  }
  if (adapters.length === 0) {
    return new MissingAdapter(specification);
  }
  if (agents.length === 0) {
    return new MissingAgent(specification);
  }

  let lastFailure: UnavailableAgent | null = null;
  for (const agent of agents) {
    let agentVersion = "";
    try {
      agentVersion = await probeVersion(
        agent,
        specification.agentVersionArguments,
        context.environment,
        context.defaultWorkspace,
        context.signal,
        specification.versionProbeTimeoutMilliseconds,
      );
    } catch (error) {
      if (context.signal.aborted) {
        context.signal.throwIfAborted();
      }
      lastFailure = probeFailure(specification, "agent", error);
      continue;
    }

    for (const adapter of adapters) {
      if (
        specification instanceof DirectAcpAgentDefinition &&
        adapter.path !== agent.path
      ) {
        continue;
      }
      let adapterVersion = "";
      let launchEnvironment: Readonly<Record<string, string>>;
      try {
        launchEnvironment = await specification.createLaunchEnvironment(
          agent,
          context,
        );
        if (specification.adapterVersionArguments.length > 0) {
          adapterVersion = await probeVersion(
            adapter,
            specification.adapterVersionArguments,
            {
              ...context.environment,
              ...launchEnvironment,
            },
            context.defaultWorkspace,
            context.signal,
            specification.versionProbeTimeoutMilliseconds,
          );
        }
      } catch (error) {
        if (context.signal.aborted) {
          context.signal.throwIfAborted();
        }
        lastFailure = probeFailure(specification, "adapter", error);
        continue;
      }

      const definition = new LocalAgentDefinition(
        specification.id,
        specification.label,
        adapter.path,
        specification.launchArguments,
        launchEnvironment,
        adapterVersion,
        agentVersion,
        adapter.identity,
        agent.identity,
        specification.promptTimeoutMilliseconds,
      );
      try {
        const acpVersion = await probeAcpReadiness(
          specification,
          definition,
          context.environment,
          context.defaultWorkspace,
          context.signal,
        );
        const verifiedAdapterVersion =
          adapterVersion.length > 0 ? adapterVersion : acpVersion;
        if (verifiedAdapterVersion.length === 0) {
          throw new AgentProbeError(
            "acp_incompatible",
            "ACP adapter did not report a version",
          );
        }
        return new AvailableAgent(
          specification,
          new LocalAgentDefinition(
            specification.id,
            specification.label,
            adapter.path,
            specification.launchArguments,
            launchEnvironment,
            verifiedAdapterVersion,
            agentVersion,
            adapter.identity,
            agent.identity,
            specification.promptTimeoutMilliseconds,
          ),
        );
      } catch (error) {
        if (context.signal.aborted) {
          context.signal.throwIfAborted();
        }
        const failure = probeFailure(specification, "adapter", error);
        if (failure instanceof AuthenticationRequiredAgent) {
          return failure;
        }
        lastFailure = failure;
      }
    }
  }
  return lastFailure ?? new IncompatibleAdapter(specification);
}
