import { spawn } from "node:child_process";
import { MiniClientError } from "./errors.ts";

const MAXIMUM_OUTPUT_CHARACTERS = 1_000_000;

export interface ProcessResult {
    readonly stderr: string;
    readonly stdout: string;
}

export async function runProcess(
    command: string,
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<ProcessResult> {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
        const child = spawn(command, arguments_, {
            env: { ...environment },
            signal,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const append = (current: string, chunk: Buffer): string => {
            const next = current + chunk.toString("utf8");
            if (next.length > MAXIMUM_OUTPUT_CHARACTERS) {
                child.kill("SIGTERM");
                reject(new MiniClientError("process_output_limit", "The local Mobius CLI produced too much output"));
            }
            return next;
        };
        child.stdout.on("data", (chunk: Buffer) => {
            stdout = append(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = append(stderr, chunk);
        });
        child.once("error", (cause) => {
            const code = signal.aborted
                ? signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
                    ? "operation_timeout"
                    : "operation_cancelled"
                : "process_failed";
            reject(new MiniClientError(code, "The local Mobius CLI failed", { cause }));
        });
        child.once("exit", (code, childSignal) => {
            if (code === 0) {
                resolve({ stderr, stdout });
                return;
            }
            reject(
                new MiniClientError(
                    signal.aborted ? "operation_cancelled" : "process_failed",
                    `The local Mobius CLI exited unsuccessfully (${code?.toString() ?? childSignal ?? "unknown"})`,
                ),
            );
        });
    });
}
