import { Worker } from "node:worker_threads";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeWorkerEnvironment } from "./environment-session-list.js";

const SESSION_MESSAGES_TIMEOUT_MILLISECONDS = 30_000;
const sessionMessagesSchema = z.array(
    z.object({
        message: z.unknown(),
        parent_agent_id: z.string().nullable(),
        parent_tool_use_id: z.string().nullable(),
        session_id: z.string(),
        type: z.enum(["user", "assistant", "system"]),
        uuid: z.string(),
    }),
);
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
void import(workerData.sdkUrl)
    .then(async ({ getSessionMessages }) => {
        parentPort.postMessage(await getSessionMessages(workerData.sessionId));
    })
    .catch((error) => {
        parentPort.postMessage({
            error: error instanceof Error ? error.message : "Claude session history loading failed",
        });
    });
`;

export function getEnvironmentSessionMessages(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionMessage[]> {
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(SESSION_MESSAGES_TIMEOUT_MILLISECONDS)]);
    operationSignal.throwIfAborted();
    const worker = new Worker(workerSource, {
        env: claudeWorkerEnvironment(environment),
        eval: true,
        workerData: { sdkUrl: import.meta.resolve("@anthropic-ai/claude-agent-sdk"), sessionId },
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
                reject(new Error(`Claude session history worker exited with code ${code}`));
            }
        });
        worker.once("message", (value: unknown) => {
            cleanup();
            if (value !== null && typeof value === "object" && "error" in value && typeof value.error === "string") {
                reject(new Error(value.error));
                return;
            }
            const decoded = sessionMessagesSchema.safeParse(value);
            if (!decoded.success) {
                reject(new Error("Claude session history loading returned invalid message data"));
                return;
            }
            resolve(decoded.data);
        });
    });
}
