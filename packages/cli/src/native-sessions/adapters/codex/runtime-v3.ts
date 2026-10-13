import type { SessionHistoryPageRequestV3, SessionHistoryPageV3 } from "@moxt-ai/mobius-protocol";
import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../../process/executable.ts";
import type { NativeAgentLaunchV3 } from "../../runtime-manager-v3.ts";
import type { NativeSessionContextV3 } from "../adapter-v3.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import { CodexNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

/** Opens one native Codex transport. Session preview itself never resumes or opens a thread. */
export async function previewCodexNativeSessionV3(
    agent: NativeAgentLaunchV3,
    session: NativeSessionContextV3,
    request: SessionHistoryPageRequestV3,
    signal: AbortSignal,
): Promise<SessionHistoryPageV3> {
    let appServer: CodexAppServerClient | null = null;
    appServer = new CodexAppServerClient({
        command: agent.command,
        cwd: session.cwd,
        environment: agent.environment,
        handlers: {
            onNotification: async () => undefined,
            onServerRequest: async (request) => {
                appServer?.respondWithError(request.id, -32601, "Read-only history preview cannot answer requests");
            },
        },
    });
    try {
        await appServer.initialize(signal);
        return await new CodexNativeSessionPreviewAdapterV3(appServer).previewMessages(session, request, signal);
    } finally {
        await closeAppServer(appServer);
    }
}

async function closeAppServer(appServer: CodexAppServerClient): Promise<void> {
    appServer.detach();
    const child = appServer.child();
    const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
    await stopProcessTree(child, captured);
}
