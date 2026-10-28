import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ProcessLaunch, ProcessTableEntry, ProcessTreeIdentity } from "./platform/contracts.ts";
import { processPlatformSupportFor } from "./platform/index.ts";

import { ProcessExecutionError } from "./process-error.ts";

export type { ProcessTreeIdentity } from "./platform/contracts.ts";
export { ProcessExecutionError } from "./process-error.ts";

const hostPlatform = processPlatformSupportFor(process.platform);

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS = 5_000;
const PROCESS_EXIT_CHECK_ATTEMPTS = 16;
const GRACEFUL_STOP_SIGNAL = 15;
const FORCED_STOP_SIGNAL = 9;

export class ExecutableIdentity {
    readonly changedAtMilliseconds: number;
    readonly device: number;
    readonly inode: number;
    readonly realPath: string;
    readonly requestedPath: string;
    readonly size: number;

    constructor(
        requestedPath: string,
        realPath_: string,
        device: number,
        inode: number,
        size: number,
        changedAtMilliseconds: number,
    ) {
        this.changedAtMilliseconds = changedAtMilliseconds;
        this.device = device;
        this.inode = inode;
        this.realPath = realPath_;
        this.requestedPath = requestedPath;
        this.size = size;
    }

    readonly matches = (candidate: ExecutableIdentity): boolean =>
        this.requestedPath === candidate.requestedPath &&
        this.realPath === candidate.realPath &&
        this.device === candidate.device &&
        this.inode === candidate.inode &&
        this.size === candidate.size &&
        this.changedAtMilliseconds === candidate.changedAtMilliseconds;
}

export class ResolvedExecutable {
    readonly identity: ExecutableIdentity;
    readonly path: string;

    constructor(identity: ExecutableIdentity) {
        this.identity = identity;
        this.path = identity.realPath;
    }
}

export class ProcessResult {
    readonly stderr: string;
    readonly stdout: string;

    constructor(stdout: string, stderr: string) {
        this.stderr = stderr;
        this.stdout = stdout;
    }
}

export interface RunProcessOptions {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly outputLimitBytes?: number;
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
}

export async function resolveExecutablePath(
    requestedPath: string,
    platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | null> {
    const absoluteRequestedPath = resolve(requestedPath);
    try {
        const resolvedPath = await processPlatformSupportFor(platform).resolveExecutableTarget(absoluteRequestedPath);
        const metadata = await stat(resolvedPath);
        if (!metadata.isFile()) {
            return null;
        }
        return new ResolvedExecutable(
            new ExecutableIdentity(
                absoluteRequestedPath,
                resolvedPath,
                metadata.dev,
                metadata.ino,
                metadata.size,
                metadata.ctimeMs,
            ),
        );
    } catch {
        return null;
    }
}

export async function findExecutableOnPath(
    executableName: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | null> {
    const support = processPlatformSupportFor(platform);
    const encodedPath = support.environmentValue(environment, "PATH") ?? "";
    const separator = support.pathDelimiter;
    const extensions = support.executableExtensions(executableName, environment);
    for (const entry of encodedPath.split(separator)) {
        if (entry.length === 0) {
            continue;
        }
        for (const extension of extensions) {
            const requestedPath = resolve(join(entry, `${executableName}${extension}`));
            const executable = await resolveExecutablePath(requestedPath, platform);
            if (executable !== null) {
                return executable;
            }
        }
    }
    return null;
}

export async function revalidateExecutable(
    identity: ExecutableIdentity,
    platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
    const current = await resolveExecutablePath(identity.requestedPath, platform);
    return current !== null && identity.matches(current.identity);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, limitBytes: number): number {
    const nextBytes = currentBytes + chunk.byteLength;
    if (nextBytes > limitBytes) {
        throw new ProcessExecutionError("process_output_limit", "The executable produced too much output");
    }
    chunks.push(chunk);
    return nextBytes;
}

function readProcessTable(): Promise<readonly ProcessTableEntry[]> {
    return hostPlatform.readProcessTable();
}

function selectProcessTree(
    entries: readonly ProcessTableEntry[],
    rootProcessId: number,
): readonly ProcessTreeIdentity[] {
    const processIds = new Set([rootProcessId]);
    for (const entry of entries) {
        if (entry.processGroupId === rootProcessId) {
            processIds.add(entry.processId);
        }
    }
    let previousSize = 0;
    while (previousSize !== processIds.size) {
        previousSize = processIds.size;
        for (const entry of entries) {
            if (processIds.has(entry.parentProcessId)) {
                processIds.add(entry.processId);
            }
        }
    }
    return entries
        .filter((entry) => processIds.has(entry.processId))
        .map((entry) => ({
            processGroupId: entry.processGroupId,
            processId: entry.processId,
        }));
}

function mergeProcessTrees(
    captured: readonly ProcessTreeIdentity[],
    current: readonly ProcessTreeIdentity[],
): readonly ProcessTreeIdentity[] {
    const processes = new Map<number, ProcessTreeIdentity>();
    for (const identity of captured) {
        processes.set(identity.processId, identity);
    }
    for (const identity of current) {
        processes.set(identity.processId, identity);
    }
    return [...processes.values()];
}

export async function captureProcessTree(child: ReturnType<typeof spawn>): Promise<readonly ProcessTreeIdentity[]> {
    if (child.pid === undefined) {
        return [];
    }
    const entries = hostPlatform.readProcessTableSynchronously();
    if (entries.length > 0) {
        return selectProcessTree(entries, child.pid);
    }
    return selectProcessTree(await readProcessTable(), child.pid);
}

async function waitForCapturedProcessesExit(
    processes: readonly ProcessTreeIdentity[],
    rootProcessId: number,
): Promise<boolean> {
    const processIds = processes
        .map((identity) => identity.processId)
        .filter((processId) => processId !== rootProcessId);
    for (let attempt = 0; attempt < PROCESS_EXIT_CHECK_ATTEMPTS; attempt += 1) {
        if (processIds.every((processId) => !hostPlatform.processExists(processId))) {
            return true;
        }
        await readProcessTable();
    }
    return processIds.every((processId) => !hostPlatform.processExists(processId));
}

export async function stopProcessTree(
    child: ReturnType<typeof spawn>,
    capturedProcesses: readonly ProcessTreeIdentity[] = [],
): Promise<void> {
    const childProcessId = child.pid;
    if (childProcessId === undefined) {
        return;
    }
    const childExited = child.exitCode !== null || child.signalCode !== null;
    const processes = mergeProcessTrees(capturedProcesses, await captureProcessTree(child));
    if (childExited && processes.length === 0) {
        return;
    }
    hostPlatform.signalCapturedProcesses(processes, childProcessId, GRACEFUL_STOP_SIGNAL);
    hostPlatform.terminateProcess(child, "SIGTERM");
    const [exitedAfterTermination, descendantsExitedAfterTermination] = await Promise.all([
        waitForProcessExit(child, PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS),
        waitForCapturedProcessesExit(processes, childProcessId),
    ]);
    if (exitedAfterTermination && descendantsExitedAfterTermination) {
        return;
    }
    hostPlatform.signalCapturedProcesses(processes, childProcessId, FORCED_STOP_SIGNAL);
    hostPlatform.terminateProcess(child, "SIGKILL");
    const [exitedAfterForce, descendantsExitedAfterForce] = await Promise.all([
        waitForProcessExit(child, PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS),
        waitForCapturedProcessesExit(processes, childProcessId),
    ]);
    if (!exitedAfterForce || !descendantsExitedAfterForce) {
        throw new ProcessExecutionError("process_termination_timeout", "The executable process could not be stopped");
    }
}

function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMilliseconds: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolveExit) => {
        let settled = false;
        const finish = (exited: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            child.removeListener("exit", handleExit);
            resolveExit(exited);
        };
        const handleExit = (): void => finish(true);
        const timeout = setTimeout(() => finish(false), timeoutMilliseconds);
        child.once("exit", handleExit);
        if (child.exitCode !== null || child.signalCode !== null) {
            finish(true);
        }
    });
}

export async function runBoundedProcess(options: RunProcessOptions): Promise<ProcessResult> {
    options.signal.throwIfAborted();
    const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const launch = executableLaunch(options.command, options.arguments);
    const child = spawn(launch.command, [...launch.arguments], {
        cwd: options.cwd,
        ...hostPlatform.spawnOptions,
        env: { ...options.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let interruptionFailure: ProcessExecutionError | null = null;
    let interruptionCleanupFailure: ProcessExecutionError | null = null;
    let stopping = false;
    const interrupted = Promise.withResolvers<void>();

    const interrupt = (failure: ProcessExecutionError): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        interruptionFailure = failure;
        const stop = async (): Promise<void> => {
            try {
                await stopProcessTree(child);
            } catch (error) {
                interruptionCleanupFailure =
                    error instanceof ProcessExecutionError
                        ? error
                        : new ProcessExecutionError(
                              "process_termination_failed",
                              "The executable process could not be stopped",
                              { cause: error },
                          );
            } finally {
                interrupted.resolve();
            }
        };
        void stop();
    };

    const collectStdout = (chunk: Buffer): void => {
        if (interruptionFailure !== null) {
            return;
        }
        try {
            stdoutBytes = appendBounded(stdout, chunk, stdoutBytes, outputLimitBytes);
        } catch (error) {
            const failure =
                error instanceof ProcessExecutionError
                    ? error
                    : new ProcessExecutionError("process_output_limit", "The executable produced too much output", {
                          cause: error,
                      });
            interrupt(failure);
        }
    };
    const collectStderr = (chunk: Buffer): void => {
        if (interruptionFailure !== null) {
            return;
        }
        try {
            stderrBytes = appendBounded(stderr, chunk, stderrBytes, outputLimitBytes);
        } catch (error) {
            const failure =
                error instanceof ProcessExecutionError
                    ? error
                    : new ProcessExecutionError("process_output_limit", "The executable produced too much output", {
                          cause: error,
                      });
            interrupt(failure);
        }
    };
    child.stdout?.on("data", collectStdout);
    child.stderr?.on("data", collectStderr);

    const timeout = setTimeout(() => {
        interrupt(new ProcessExecutionError("process_timeout", "The executable probe timed out"));
    }, options.timeoutMilliseconds);
    const abort = (): void =>
        interrupt(
            new ProcessExecutionError("process_cancelled", "The executable probe was cancelled", {
                cause: options.signal.reason,
            }),
        );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) {
        abort();
    }

    try {
        const exit = new Promise<number>((resolveExit, rejectExit) => {
            child.once("error", rejectExit);
            child.once("exit", (code) => resolveExit(code ?? 1));
        });
        const exitCode = await Promise.race([exit, interrupted.promise.then(() => -1)]);
        if (interruptionCleanupFailure !== null) {
            throw interruptionCleanupFailure;
        }
        if (interruptionFailure !== null) {
            throw interruptionFailure;
        }
        if (exitCode !== 0) {
            throw new ProcessExecutionError("process_exit_failed", "The executable probe failed");
        }
        return new ProcessResult(Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"));
    } catch (error) {
        if (error instanceof ProcessExecutionError) {
            throw error;
        }
        throw new ProcessExecutionError("process_spawn_failed", "The executable could not be started", {
            cause: error,
        });
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        child.stdout?.removeListener("data", collectStdout);
        child.stderr?.removeListener("data", collectStderr);
        if (stopping) {
            await interrupted.promise;
        } else {
            await stopProcessTree(child);
        }
    }
}

export function executableLaunch(command: string, args: readonly string[]): ProcessLaunch {
    return hostPlatform.executableLaunch(command, args);
}

export const platformSpawnOptions = hostPlatform.spawnOptions;
