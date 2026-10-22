import type { WebSocket } from "undici";
import type { ExternalContentStore } from "../../session/content/external-content-store.ts";
import type { AgentRuntimeManager } from "../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../session/native/native-session-browser.ts";
import type { RuntimeSessionEventProjection } from "../../session/prompt/prompt-lifecycle.ts";
import type { RuntimeOperationState } from "../../session/turn/execution-receipts.ts";
import type { RuntimeSessions } from "../../session/turn/session-turns.ts";
import type { WorkspaceDirectoryService } from "../../session/workspace/workspace-directory.ts";
import type { Timer } from "../../util/timer.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";

export interface CommandContext {
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: RuntimeOperationState;
    readonly eventProjection: RuntimeSessionEventProjection;
    readonly externalContent: ExternalContentStore;
    readonly sessionTurns: RuntimeSessions;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}
