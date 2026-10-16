import { parentPort, workerData } from "node:worker_threads";
import { forkSession, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";

// The SDK reads CLAUDE_CONFIG_DIR from process.env, so session-store operations run in a Worker that
// owns the Agent's environment. scripts/generate-claude-session-worker.ts bundles this program with
// the SDK into one source string: a host that bundles Mobius into a single file has no SDK module
// on disk for a Worker to import.

export type EnvironmentSessionRequest =
    | { readonly kind: "fork"; readonly cwd: string; readonly sessionId: string }
    | { readonly kind: "list"; readonly cwd: string | undefined }
    | { readonly kind: "messages"; readonly sessionId: string };

function decodeRequest(value: unknown): EnvironmentSessionRequest | undefined {
    if (value === null || typeof value !== "object" || !("kind" in value)) {
        return undefined;
    }
    const sessionId = "sessionId" in value && typeof value.sessionId === "string" ? value.sessionId : undefined;
    const cwd = "cwd" in value && typeof value.cwd === "string" ? value.cwd : undefined;
    switch (value.kind) {
        case "fork":
            return sessionId === undefined || cwd === undefined ? undefined : { cwd, kind: "fork", sessionId };
        case "list":
            return { cwd, kind: "list" };
        case "messages":
            return sessionId === undefined ? undefined : { kind: "messages", sessionId };
        default:
            return undefined;
    }
}

async function run(request: EnvironmentSessionRequest): Promise<unknown> {
    switch (request.kind) {
        case "fork": {
            const forked = await forkSession(request.sessionId, { dir: request.cwd });
            return { kind: "succeeded", sessionId: forked.sessionId };
        }
        case "list":
            return {
                kind: "succeeded",
                sessions: await listSessions(request.cwd === undefined ? {} : { dir: request.cwd }),
            };
        case "messages":
            return { kind: "succeeded", messages: await getSessionMessages(request.sessionId) };
    }
}

async function respond(value: unknown): Promise<unknown> {
    const request = decodeRequest(value);
    if (request === undefined) {
        return { kind: "failed", message: "Claude session worker received an invalid request" };
    }
    try {
        return await run(request);
    } catch (error) {
        return {
            kind: "failed",
            message: error instanceof Error ? error.message : `Claude session ${request.kind} failed`,
        };
    }
}

void respond(workerData).then((result) => parentPort?.postMessage(result));
