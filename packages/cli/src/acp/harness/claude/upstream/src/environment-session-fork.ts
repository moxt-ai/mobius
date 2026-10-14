import { Worker } from "node:worker_threads";
import { claudeWorkerEnvironment } from "./environment-session-list.js";

const SESSION_FORK_TIMEOUT_MILLISECONDS = 30_000;
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
void import(workerData.sdkUrl)
    .then(async ({ forkSession }) => {
        const forked = await forkSession(workerData.sessionId, { dir: workerData.cwd });
        parentPort.postMessage({ kind: "succeeded", sessionId: forked.sessionId });
    })
    .catch((error) => {
        parentPort.postMessage({
            kind: "failed",
            message: error instanceof Error ? error.message : "Claude session fork failed",
        });
    });
`;

type WorkerResult =
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "succeeded"; readonly sessionId: string };

function decodeWorkerResult(value: unknown): WorkerResult {
    if (value === null || typeof value !== "object" || !("kind" in value)) {
        return { kind: "failed", message: "Claude session fork returned an invalid result" };
    }
    if (value.kind === "failed" && "message" in value && typeof value.message === "string") {
        return { kind: "failed", message: value.message };
    }
    if (value.kind === "succeeded" && "sessionId" in value && typeof value.sessionId === "string") {
        return { kind: "succeeded", sessionId: value.sessionId };
    }
    return { kind: "failed", message: "Claude session fork returned an invalid result" };
}

export function forkEnvironmentSession(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    cwd: string,
    signal: AbortSignal,
): Promise<string> {
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(SESSION_FORK_TIMEOUT_MILLISECONDS)]);
    operationSignal.throwIfAborted();
    const worker = new Worker(workerSource, {
        env: claudeWorkerEnvironment(environment),
        eval: true,
        workerData: {
            cwd,
            sdkUrl: import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
            sessionId,
        },
    });

    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            operationSignal.removeEventListener("abort", onAbort);
            worker.removeAllListeners();
            void worker.terminate();
        };
        const onAbort = (): void => {
            cleanup();
            reject(operationSignal.reason);
        };
        operationSignal.addEventListener("abort", onAbort, { once: true });
        worker.once("error", (error) => {
            cleanup();
            reject(error);
        });
        worker.once("exit", (code) => {
            if (code !== 0) {
                cleanup();
                reject(new Error(`Claude session fork worker exited with code ${code}`));
            }
        });
        worker.once("message", (value: unknown) => {
            const result = decodeWorkerResult(value);
            cleanup();
            if (result.kind === "failed") {
                reject(new Error(result.message));
                return;
            }
            resolve(result.sessionId);
        });
    });
}
