import { Worker } from "node:worker_threads";
import type { EnvironmentSessionRequest } from "./environment-session-worker.js";
import { environmentSessionWorkerSource } from "./generated/environment-session-worker-source.js";

const SESSION_LIST_TIMEOUT_MILLISECONDS = 30_000;

export type EnvironmentSessionInfo = {
    readonly cwd?: string;
    readonly lastModified: number;
    readonly sessionId: string;
    readonly summary: string;
};

type WorkerResult =
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "succeeded"; readonly sessions: readonly EnvironmentSessionInfo[] };

function decodeWorkerResult(value: unknown): WorkerResult {
    if (value === null || typeof value !== "object" || !("kind" in value)) {
        return { kind: "failed", message: "Claude session listing returned an invalid result" };
    }
    if (value.kind === "failed" && "message" in value && typeof value.message === "string") {
        return { kind: "failed", message: value.message };
    }
    if (value.kind !== "succeeded" || !("sessions" in value) || !Array.isArray(value.sessions)) {
        return { kind: "failed", message: "Claude session listing returned an invalid result" };
    }
    const sessions: EnvironmentSessionInfo[] = [];
    for (const session of value.sessions) {
        if (
            session === null ||
            typeof session !== "object" ||
            !("sessionId" in session) ||
            typeof session.sessionId !== "string" ||
            !("summary" in session) ||
            typeof session.summary !== "string" ||
            !("lastModified" in session) ||
            typeof session.lastModified !== "number"
        ) {
            return { kind: "failed", message: "Claude session listing returned invalid session metadata" };
        }
        const cwd = "cwd" in session && typeof session.cwd === "string" ? session.cwd : undefined;
        sessions.push({
            ...(cwd === undefined ? {} : { cwd }),
            lastModified: session.lastModified,
            sessionId: session.sessionId,
            summary: session.summary,
        });
    }
    return { kind: "succeeded", sessions };
}

export function claudeWorkerEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.Dict<string> {
    return Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}

export function listEnvironmentSessions(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string | undefined,
    signal: AbortSignal,
): Promise<readonly EnvironmentSessionInfo[]> {
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(SESSION_LIST_TIMEOUT_MILLISECONDS)]);
    operationSignal.throwIfAborted();
    const worker = new Worker(environmentSessionWorkerSource, {
        env: claudeWorkerEnvironment(environment),
        eval: true,
        workerData: { cwd, kind: "list" } satisfies EnvironmentSessionRequest,
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
                reject(new Error(`Claude session listing worker exited with code ${code}`));
            }
        });
        worker.once("message", (value: unknown) => {
            const result = decodeWorkerResult(value);
            cleanup();
            if (result.kind === "failed") {
                reject(new Error(result.message));
                return;
            }
            resolve(result.sessions);
        });
    });
}
