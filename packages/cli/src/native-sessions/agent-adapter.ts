import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError, type AcpPrepareOptions, type AcpSessionManager } from "../acp/session-manager.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { acpSessionAdapter } from "./acp-adapter.ts";
import { codexSessionAdapter } from "./codex-adapter.ts";

export interface NativeSessionAdapterContext {
    readonly sessions: AcpSessionManager;
    readonly directories: WorkspaceDirectoryService;
    readonly bindingId: string;
    readonly options: AcpPrepareOptions;
    readonly nativeSessionId: string;
}

export interface NativeSessionAdapter {
    readonly linkedHistory: (context: NativeSessionAdapterContext) => Promise<NativeSessionHistory>;
    readonly history: (context: NativeSessionAdapterContext) => Promise<NativeSessionHistory>;
    readonly preview: (context: NativeSessionAdapterContext) => Promise<NativeSessionHistory>;
}

const genericSessionAdapter: NativeSessionAdapter = {
    linkedHistory: async () => {
        throw new AcpExecutionError("This Agent does not support Chat history", {}, "native_session_unsupported");
    },
    history: async () => {
        throw new AcpExecutionError("Native history is unavailable for this Agent", {}, "native_session_unsupported");
    },
    preview: async ({ sessions, options, nativeSessionId }) =>
        await sessions.previewNativeSession(options, nativeSessionId),
};

export function nativeSessionAdapter(agentId: string): NativeSessionAdapter {
    if (agentId === "codex") {
        return codexSessionAdapter;
    }
    if (agentId === "claude" || agentId === "opencode" || agentId === "pi") {
        return acpSessionAdapter;
    }
    return genericSessionAdapter;
}
