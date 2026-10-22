import { isAbsolute } from "node:path";
import {
    findExecutableOnPath,
    ProcessExecutionError,
    type ResolvedExecutable,
    resolveExecutablePath,
    runBoundedProcess,
} from "../../util/process/executable.ts";
import {
    DirectAcpAgentDefinition,
    InProcessAcpAgentDefinition,
    type LocalAgentSpecification,
} from "../specification/agent-specification.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { normalizeVersionOutput } from "./version-output.ts";

async function resolveSpecificationExecutables(
    executableName: string,
    overrideVariable: string,
    resolveInstalled: () => Promise<readonly ResolvedExecutable[]>,
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
    const external = await findExecutableOnPath(executableName, context.environment, context.platform);
    const installed = await resolveInstalled();
    const executables: ResolvedExecutable[] = [];
    const paths = new Set<string>();
    if (external !== null) {
        executables.push(external);
        paths.add(external.path);
    }
    for (const executable of installed) {
        if (!paths.has(executable.path)) {
            executables.push(executable);
            paths.add(executable.path);
        }
    }
    return executables;
}

export async function resolveAgentExecutables(
    specification: LocalAgentSpecification,
    context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
    return await resolveSpecificationExecutables(
        specification.agentExecutable,
        specification.agentOverrideVariable,
        async () => await specification.resolveInstalledAgentExecutables(context),
        context,
    );
}

export async function resolveAdapterExecutables(
    specification: LocalAgentSpecification,
    context: LocalAgentDiscoveryContext,
): Promise<readonly ResolvedExecutable[]> {
    if (specification instanceof DirectAcpAgentDefinition || specification instanceof InProcessAcpAgentDefinition) {
        return await resolveAgentExecutables(specification, context);
    }
    throw new Error("Unsupported local Agent execution topology");
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

export async function probeVersion(
    executable: ResolvedExecutable,
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    defaultWorkspace: string,
    signal: AbortSignal,
    timeoutMilliseconds: number,
    normalize: (output: string) => string = normalizeVersionOutput,
): Promise<string> {
    const result = await runBoundedProcess({
        arguments: arguments_,
        command: executable.path,
        cwd: defaultWorkspace,
        environment,
        signal,
        timeoutMilliseconds,
    });
    const version = normalize(result.stdout || result.stderr);
    if (version.length === 0) {
        throw new ProcessExecutionError("process_exit_failed", "The executable did not report a version");
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
                specification.normalizeAgentVersion,
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
