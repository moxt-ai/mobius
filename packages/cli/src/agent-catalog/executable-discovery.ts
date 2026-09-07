import { isAbsolute, join } from "node:path";

import { validateManagedAdapter } from "../agent-installation/managed-adapter-installer.ts";
import {
  findExecutableOnPath,
  ProcessExecutionError,
  type ResolvedExecutable,
  resolveExecutablePath,
  runBoundedProcess,
} from "../process/executable.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import {
  BridgedAcpAgentDefinition,
  DirectAcpAgentDefinition,
  type LocalAgentSpecification,
} from "./agent-specification.ts";

async function resolveManagedExecutable(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<ResolvedExecutable | null> {
  try {
    return await specification.resolveManagedAgent(
      readStateDirectory(context.environment),
      context.platform ?? process.platform,
      context.signal,
    );
  } catch {
    context.signal.throwIfAborted();
    return null;
  }
}

async function resolveManagedAdapterExecutable(
  specification: BridgedAcpAgentDefinition,
  context: LocalAgentDiscoveryContext,
): Promise<ResolvedExecutable | null> {
  let managed: ResolvedExecutable;
  try {
    managed = await validateManagedAdapter(
      join(
        readStateDirectory(context.environment),
        "adapters",
        specification.id,
        specification.adapterVersion,
      ),
      specification,
    );
  } catch {
    return null;
  }
  return managed;
}

async function resolveSpecificationExecutables(
  executableName: string,
  overrideVariable: string,
  resolveManaged: () => Promise<ResolvedExecutable | null>,
  context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
  const override = context.environment[overrideVariable];
  if (override !== undefined) {
    if (override.length === 0 || !isAbsolute(override)) {
      return [];
    }
    const executable = await resolveExecutablePath(override, context.platform);
    return executable === null ? [] : [executable];
  }
  const external = await findExecutableOnPath(
    executableName,
    context.environment,
    context.platform,
  );
  const managed = await resolveManaged();
  if (external === null) {
    return managed === null ? [] : [managed];
  }
  if (managed === null || managed.path === external.path) {
    return [external];
  }
  return [external, managed];
}

export async function resolveAgentExecutables(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
  return await resolveSpecificationExecutables(
    specification.agentExecutable,
    specification.agentOverrideVariable,
    async () => await resolveManagedExecutable(specification, context),
    context,
  );
}

export async function resolveAdapterExecutables(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
  if (specification instanceof DirectAcpAgentDefinition) {
    return await resolveAgentExecutables(specification, context);
  }
  if (!(specification instanceof BridgedAcpAgentDefinition)) {
    throw new Error("Unsupported local Agent execution topology");
  }
  return await resolveSpecificationExecutables(
    specification.adapterExecutable,
    specification.adapterOverrideVariable,
    async () => await resolveManagedAdapterExecutable(specification, context),
    context,
  );
}

export async function resolveAgentExecutable(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<ResolvedExecutable | null> {
  const executables = await resolveAgentExecutables(specification, context);
  return executables[0] ?? null;
}

export async function resolveAdapterExecutable(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<ResolvedExecutable | null> {
  const executables = await resolveAdapterExecutables(specification, context);
  return executables[0] ?? null;
}

export function normalizedVersion(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 128) ?? "";
}

export async function probeVersion(
  executable: ResolvedExecutable,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultWorkspace: string,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<string> {
  const result = await runBoundedProcess({
    arguments: arguments_,
    command: executable.path,
    cwd: defaultWorkspace,
    environment,
    signal,
    timeoutMilliseconds,
  });
  const version = normalizedVersion(result.stdout || result.stderr);
  if (version.length === 0) {
    throw new ProcessExecutionError(
      "process_exit_failed",
      "The executable did not report a version",
    );
  }
  return version;
}

export class VerifiedAgentExecutable {
  readonly executable: ResolvedExecutable;
  readonly version: string;

  constructor(executable: ResolvedExecutable, version: string) {
    this.executable = executable;
    this.version = version;
  }
}

export async function findVerifiedAgentExecutable(
  specification: LocalAgentSpecification,
  context: LocalAgentDiscoveryContext,
): Promise<VerifiedAgentExecutable | null> {
  const executables = await resolveAgentExecutables(specification, context);
  for (const executable of executables) {
    try {
      const version = await probeVersion(
        executable,
        specification.agentVersionArguments,
        context.environment,
        context.defaultWorkspace,
        context.signal,
        specification.versionProbeTimeoutMilliseconds,
      );
      return new VerifiedAgentExecutable(executable, version);
    } catch {
      if (context.signal.aborted) {
        context.signal.throwIfAborted();
      }
    }
  }
  return null;
}
