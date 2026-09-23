import { execFile, spawn } from "node:child_process";
import { constants, readdirSync, readFileSync } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS = 5_000;
const PROCESS_TABLE_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_TABLE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PROCESS_EXIT_CHECK_ATTEMPTS = 16;
const GRACEFUL_STOP_SIGNAL = 15;
const FORCED_STOP_SIGNAL = 9;

export interface ProcessTreeIdentity {
    readonly processGroupId: number;
    readonly processId: number;
}

interface ProcessTableEntry extends ProcessTreeIdentity {
    readonly parentProcessId: number;
}

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

export class ProcessExecutionError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ProcessExecutionError";
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

function executableExtensions(
    executableName: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform,
): readonly string[] {
    if (platform !== "win32") {
        return [""];
    }
    if (/\.[a-zA-Z0-9]+$/.test(executableName)) {
        return [""];
    }
    const configured = environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
    const extensions = configured
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension.length > 0)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
    return extensions.length > 0 ? extensions : [".EXE"];
}

export async function resolveExecutablePath(
    requestedPath: string,
    platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | null> {
    const absoluteRequestedPath = resolve(requestedPath);
    try {
        const resolvedPath = await realpath(absoluteRequestedPath);
        const metadata = await stat(resolvedPath);
        if (!metadata.isFile()) {
            return null;
        }
        if (platform !== "win32") {
            await access(resolvedPath, constants.X_OK);
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
    const encodedPath = environment["PATH"] ?? "";
    const separator = platform === "win32" ? ";" : ":";
    const extensions = executableExtensions(executableName, environment, platform);
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

function parseProcessTable(output: string): readonly ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    for (const line of output.split("\n")) {
        const groups = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s*$/.exec(line)?.groups;
        if (groups === undefined) {
            continue;
        }
        const processId = Number(groups["pid"]);
        const parentProcessId = Number(groups["ppid"]);
        const processGroupId = Number(groups["pgid"]);
        if (
            !Number.isSafeInteger(processId) ||
            processId <= 0 ||
            !Number.isSafeInteger(parentProcessId) ||
            parentProcessId < 0 ||
            !Number.isSafeInteger(processGroupId) ||
            processGroupId <= 0
        ) {
            continue;
        }
        entries.push({ parentProcessId, processGroupId, processId });
    }
    return entries;
}

function appendLinuxProcessTableEntry(entries: ProcessTableEntry[], processId: number, encoded: string): void {
    const closingParenthesis = encoded.lastIndexOf(")");
    if (!encoded.startsWith(`${processId.toString()} (`) || closingParenthesis < 0) {
        return;
    }
    const fields = encoded
        .slice(closingParenthesis + 1)
        .trim()
        .split(/\s+/);
    const parentProcessId = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    if (
        !Number.isSafeInteger(parentProcessId) ||
        parentProcessId < 0 ||
        !Number.isSafeInteger(processGroupId) ||
        processGroupId <= 0
    ) {
        return;
    }
    entries.push({ parentProcessId, processGroupId, processId });
}

async function readLinuxProcessTable(): Promise<readonly ProcessTableEntry[]> {
    const entries: ProcessTableEntry[] = [];
    try {
        const directories = await readdir("/proc", { withFileTypes: true });
        for (const directory of directories) {
            if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) {
                continue;
            }
            const processId = Number(directory.name);
            if (!Number.isSafeInteger(processId) || processId <= 0) {
                continue;
            }
            try {
                appendLinuxProcessTableEntry(
                    entries,
                    processId,
                    await readFile(join("/proc", directory.name, "stat"), "utf8"),
                );
            } catch {
                // Processes can exit while procfs is being enumerated.
            }
        }
    } catch {
        // A restricted Linux runtime may not mount procfs; the fixed ps fallback runs below.
    }
    return entries;
}

function readLinuxProcessTableSynchronously(): readonly ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    try {
        const directories = readdirSync("/proc", { withFileTypes: true });
        for (const directory of directories) {
            if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) {
                continue;
            }
            const processId = Number(directory.name);
            if (!Number.isSafeInteger(processId) || processId <= 0) {
                continue;
            }
            try {
                appendLinuxProcessTableEntry(
                    entries,
                    processId,
                    readFileSync(join("/proc", directory.name, "stat"), "utf8"),
                );
            } catch {
                // Processes can exit while procfs is being enumerated.
            }
        }
    } catch {
        // A restricted Linux runtime may not mount procfs; the asynchronous fallback runs below.
    }
    return entries;
}

function readProcessTableWithPs(executable: string): Promise<readonly ProcessTableEntry[]> {
    return new Promise((resolveTable) => {
        execFile(
            executable,
            ["-axo", "pid=,ppid=,pgid="],
            {
                encoding: "utf8",
                maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT_BYTES,
                signal: AbortSignal.timeout(PROCESS_TABLE_TIMEOUT_MILLISECONDS),
                timeout: PROCESS_TABLE_TIMEOUT_MILLISECONDS,
            },
            (error, stdout) => {
                resolveTable(error === null ? parseProcessTable(stdout) : []);
            },
        );
    });
}

async function readLinuxProcessTableWithFallback(): Promise<readonly ProcessTableEntry[]> {
    const procfsEntries = await readLinuxProcessTable();
    if (procfsEntries.length > 0) {
        return procfsEntries;
    }
    for (const candidate of ["/usr/bin/ps", "/bin/ps", "/run/current-system/sw/bin/ps"]) {
        const executable = await resolveExecutablePath(candidate);
        if (executable === null) {
            continue;
        }
        const entries = await readProcessTableWithPs(executable.identity.requestedPath);
        if (entries.length > 0) {
            return entries;
        }
    }
    return [];
}

function readProcessTable(): Promise<readonly ProcessTableEntry[]> {
    if (process.platform === "win32") {
        return Promise.resolve([]);
    }
    if (process.platform === "linux") {
        return readLinuxProcessTableWithFallback();
    }
    return readProcessTableWithPs(process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps");
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
    if (process.platform === "win32" || child.pid === undefined) {
        return [];
    }
    if (process.platform === "linux") {
        const procfsEntries = readLinuxProcessTableSynchronously();
        if (procfsEntries.length > 0) {
            return selectProcessTree(procfsEntries, child.pid);
        }
    }
    return selectProcessTree(await readProcessTable(), child.pid);
}

function signalCapturedProcessGroups(
    processes: readonly ProcessTreeIdentity[],
    rootProcessId: number,
    signal: number,
): void {
    const processIds = new Set(processes.map((identity) => identity.processId));
    const signalledGroups = new Set<number>();
    for (const identity of processes) {
        const isRootProcessGroup = identity.processGroupId === rootProcessId;
        if (
            (!isRootProcessGroup && !processIds.has(identity.processGroupId)) ||
            signalledGroups.has(identity.processGroupId)
        ) {
            continue;
        }
        try {
            process.kill(-identity.processGroupId, signal);
            signalledGroups.add(identity.processGroupId);
        } catch {
            // A concurrently exited group no longer needs cleanup.
        }
    }
    for (const identity of processes) {
        if (
            identity.processId === rootProcessId ||
            identity.processGroupId === rootProcessId ||
            signalledGroups.has(identity.processGroupId)
        ) {
            continue;
        }
        try {
            process.kill(identity.processId, signal);
        } catch {
            // A concurrently exited process no longer needs cleanup.
        }
    }
}

function processExists(processId: number): boolean {
    if (process.platform === "linux") {
        try {
            const encoded = readFileSync(join("/proc", processId.toString(), "stat"), "utf8");
            const closingParenthesis = encoded.lastIndexOf(")");
            if (closingParenthesis >= 0) {
                const processState = encoded
                    .slice(closingParenthesis + 1)
                    .trimStart()
                    .charAt(0);
                if (processState === "Z" || processState === "X") {
                    return false;
                }
            }
        } catch {
            // Fall through so restricted procfs mounts still use the portable signal probe.
        }
    }
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForCapturedProcessesExit(
    processes: readonly ProcessTreeIdentity[],
    rootProcessId: number,
): Promise<boolean> {
    const processIds = processes
        .map((identity) => identity.processId)
        .filter((processId) => processId !== rootProcessId);
    for (let attempt = 0; attempt < PROCESS_EXIT_CHECK_ATTEMPTS; attempt += 1) {
        if (processIds.every((processId) => !processExists(processId))) {
            return true;
        }
        await readProcessTable();
    }
    return processIds.every((processId) => !processExists(processId));
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return;
    }
    if (process.platform !== "win32") {
        try {
            process.kill(-child.pid, "SIGTERM");
            return;
        } catch {
            // Fall through when the process did not create a process group.
        }
    }
    child.kill("SIGTERM");
}

function forceTerminateProcess(child: ReturnType<typeof spawn>): void {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return;
    }
    if (process.platform !== "win32") {
        try {
            process.kill(-child.pid, "SIGKILL");
            return;
        } catch {
            // Fall through when the process did not create a process group.
        }
    }
    child.kill("SIGKILL");
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
    signalCapturedProcessGroups(processes, childProcessId, GRACEFUL_STOP_SIGNAL);
    terminateProcess(child);
    const [exitedAfterTermination, descendantsExitedAfterTermination] = await Promise.all([
        waitForProcessExit(child, PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS),
        waitForCapturedProcessesExit(processes, childProcessId),
    ]);
    if (exitedAfterTermination && descendantsExitedAfterTermination) {
        return;
    }
    signalCapturedProcessGroups(processes, childProcessId, FORCED_STOP_SIGNAL);
    forceTerminateProcess(child);
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
    const child = spawn(options.command, [...options.arguments], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
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
