import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS = 5_000;

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

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference.length === 0 ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
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
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
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
  approvedRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedExecutable | null> {
  const encodedPath = environment["PATH"] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const approvedRealPath = await realpath(resolve(approvedRoot));
  const extensions = executableExtensions(
    executableName,
    environment,
    platform,
  );
  for (const entry of encodedPath.split(separator)) {
    if (entry.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const requestedPath = resolve(
        join(entry, `${executableName}${extension}`),
      );
      const executable = await resolveExecutablePath(requestedPath, platform);
      if (
        executable !== null &&
        !isInside(approvedRealPath, requestedPath) &&
        !isInside(approvedRealPath, executable.path)
      ) {
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

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  limitBytes: number,
): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > limitBytes) {
    throw new ProcessExecutionError(
      "process_output_limit",
      "The executable produced too much output",
    );
  }
  chunks.push(chunk);
  return nextBytes;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
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
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
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
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  terminateProcess(child);
  const exitedAfterTermination = await waitForProcessExit(
    child,
    PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS,
  );
  if (exitedAfterTermination) {
    return;
  }
  forceTerminateProcess(child);
  const exitedAfterForce = await waitForProcessExit(
    child,
    PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS,
  );
  if (!exitedAfterForce) {
    throw new ProcessExecutionError(
      "process_termination_timeout",
      "The executable process could not be stopped",
    );
  }
}

function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds: number,
): Promise<boolean> {
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

export async function runBoundedProcess(
  options: RunProcessOptions,
): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
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
          : new ProcessExecutionError(
              "process_output_limit",
              "The executable produced too much output",
              { cause: error },
            );
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
          : new ProcessExecutionError(
              "process_output_limit",
              "The executable produced too much output",
              { cause: error },
            );
      interrupt(failure);
    }
  };
  child.stdout?.on("data", collectStdout);
  child.stderr?.on("data", collectStderr);

  const timeout = setTimeout(() => {
    interrupt(
      new ProcessExecutionError(
        "process_timeout",
        "The executable probe timed out",
      ),
    );
  }, options.timeoutMilliseconds);
  const abort = (): void =>
    interrupt(
      new ProcessExecutionError(
        "process_cancelled",
        "The executable probe was cancelled",
        { cause: options.signal.reason },
      ),
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
    const exitCode = await Promise.race([
      exit,
      interrupted.promise.then(() => -1),
    ]);
    if (interruptionCleanupFailure !== null) {
      throw interruptionCleanupFailure;
    }
    if (interruptionFailure !== null) {
      throw interruptionFailure;
    }
    if (exitCode !== 0) {
      throw new ProcessExecutionError(
        "process_exit_failed",
        "The executable probe failed",
      );
    }
    return new ProcessResult(
      Buffer.concat(stdout).toString("utf8"),
      Buffer.concat(stderr).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof ProcessExecutionError) {
      throw error;
    }
    throw new ProcessExecutionError(
      "process_spawn_failed",
      "The executable could not be started",
      { cause: error },
    );
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
