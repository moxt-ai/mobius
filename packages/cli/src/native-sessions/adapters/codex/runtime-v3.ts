import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../../process/executable.ts";
import type { NativeAgentLaunchV3, NativeSessionAdapterPreviewLeaseV3 } from "../../runtime-manager-v3.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import { CodexNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

/** Opens one native Codex transport. Session preview itself never resumes or opens a thread. */
export async function openCodexNativeSessionPreviewV3(
    agent: NativeAgentLaunchV3,
    cwd: string,
    signal: AbortSignal,
): Promise<NativeSessionAdapterPreviewLeaseV3> {
    let appServer: CodexAppServerClient | null = null;
    appServer = new CodexAppServerClient({
        command: agent.command,
        cwd,
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
    } catch (error) {
        await closeAppServer(appServer);
        throw error;
    }
    return {
        adapter: new CodexNativeSessionPreviewAdapterV3(appServer),
        close: async () => await closeAppServer(appServer),
    };
}

async function closeAppServer(appServer: CodexAppServerClient): Promise<void> {
    appServer.detach();
    const child = appServer.child();
    const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
    await stopProcessTree(child, captured);
}
