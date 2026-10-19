import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "../../acp/agent-runtime-manager.ts";
import type { WorkspaceDirectoryService } from "../../authorization/workspace-directory.ts";
import type { ExternalContentStore } from "../../external-content/local-external-content-store.ts";
import type { NativeSessionService } from "../../native-sessions/service.ts";
import type { DaemonSessionEventProjection } from "../../session-event-projection.ts";
import type { DaemonConfig } from "../config.ts";
import type { DaemonOperationState } from "../relay/daemon-operation-state.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { DaemonTimer } from "../relay/timer.ts";
import type { DaemonTurnRegistry } from "../turn-registry.ts";

export interface CommandContext {
    readonly config: DaemonConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: DaemonOperationState;
    readonly eventProjection: DaemonSessionEventProjection;
    readonly externalContent: ExternalContentStore;
    readonly activeTurns: DaemonTurnRegistry;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: DaemonTimer;
}
