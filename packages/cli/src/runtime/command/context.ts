import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "../../acp/agent-runtime-manager.ts";
import type { ExternalContentStore } from "../../acp/external-content/local-external-content-store.ts";
import type { NativeSessionService } from "../../native-sessions/service.ts";
import type { RuntimeOperationState } from "../admission.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { Timer } from "../relay/timer.ts";
import type { RuntimeSessionEventProjection } from "../session/session-event-projection.ts";
import type { RuntimeSessions } from "../sessions.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";

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
