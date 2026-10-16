import { Worker } from "node:worker_threads";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeWorkerEnvironment } from "./environment-session-list.js";
import type { EnvironmentSessionRequest } from "./environment-session-worker.js";
import { environmentSessionWorkerSource } from "./generated/environment-session-worker-source.js";

const SESSION_MESSAGES_TIMEOUT_MILLISECONDS = 30_000;
const workerResultSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("failed"), message: z.string() }),
    z.object({
        kind: z.literal("succeeded"),
        messages: z.array(
            z.object({
                message: z.unknown(),
                parent_agent_id: z.string().nullable(),
                parent_tool_use_id: z.string().nullable(),
                session_id: z.string(),
                type: z.enum(["user", "assistant", "system"]),
                uuid: z.string(),
            }),
        ),
    }),
]);

export function getEnvironmentSessionMessages(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionMessage[]> {
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(SESSION_MESSAGES_TIMEOUT_MILLISECONDS)]);
    operationSignal.throwIfAborted();
    const worker = new Worker(environmentSessionWorkerSource, {
        env: claudeWorkerEnvironment(environment),
        eval: true,
        workerData: { kind: "messages", sessionId } satisfies EnvironmentSessionRequest,
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
            const result = workerResultSchema.safeParse(value);
            if (!result.success) {
                reject(new Error("Claude session history loading returned invalid message data"));
                return;
            }
            if (result.data.kind === "failed") {
                reject(new Error(result.data.message));
                return;
            }
            resolve(result.data.messages);
        });
    });
}
