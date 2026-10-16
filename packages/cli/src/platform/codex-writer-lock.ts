import type { BigIntStats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess } from "../util/process/executable.ts";
import { ProcessExecutionError } from "../util/process/process-error.ts";

// Probe ownership, not the existence of Codex's potentially stale lock file.
export async function codexWriterLocked(
    threadId: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
    signal: AbortSignal,
): Promise<boolean> {
    signal.throwIfAborted();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(threadId)) {
        throw new ProcessExecutionError("codex_lock_invalid_thread", "Invalid Codex thread identity");
    }
    const path = join(
        environment["CODEX_HOME"] ?? join(homedir(), ".codex"),
        "thread-writer-locks",
        `${threadId}.lock`,
    );
    if (process.platform === "linux") {
        let metadata: BigIntStats;
        try {
            metadata = await stat(path, { bigint: true });
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return false;
            }
            throw error;
        }
        const locks = await readFile("/proc/locks", { encoding: "utf8", signal });
        const major = ((metadata.dev >> 8n) & 0xfffn) | ((metadata.dev >> 32n) & 0xfffff000n);
        const minor = (metadata.dev & 0xffn) | ((metadata.dev >> 12n) & 0xffffff00n);
        return locks.split("\n").some((line) => {
            const fields = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([\da-f]+):([\da-f]+):(\d+)\s/iu.exec(line);
            return (
                fields?.[1] !== undefined &&
                fields[2] !== undefined &&
                fields[3] !== undefined &&
                BigInt(`0x${fields[1]}`) === major &&
                BigInt(`0x${fields[2]}`) === minor &&
                BigInt(fields[3]) === metadata.ino
            );
        });
    }
    if (process.platform === "win32") {
        const result = await runBoundedProcess({
            command: join(
                environment["SystemRoot"] ?? "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
            ),
            arguments: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `
$ErrorActionPreference = 'Stop'
try {
    $file = [IO.File]::Open($env:MOBIUS_CODEX_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
} catch [IO.FileNotFoundException] { Write-Output 'idle'; exit 0 }
catch [IO.DirectoryNotFoundException] { Write-Output 'idle'; exit 0 }
try {
    try { $file.Lock(0, [long]::MaxValue) }
    catch [IO.IOException] {
        if (($_.Exception.HResult -band 65535) -eq 33) { Write-Output 'locked'; exit 0 }
        throw
    }
    $file.Unlock(0, [long]::MaxValue)
    Write-Output 'idle'
} finally { $file.Dispose() }
`,
            ],
            cwd,
            environment: { ...environment, MOBIUS_CODEX_LOCK_PATH: path },
            signal,
            timeoutMilliseconds: 10_000,
        });
        const state = result.stdout.trim();
        if (state !== "idle" && state !== "locked") {
            throw new ProcessExecutionError("codex_lock_invalid_response", "Invalid Codex lock probe response");
        }
        return state === "locked";
    }
    // Other hosts retain normal resume behavior; errors never select queued execution.
    return false;
}
