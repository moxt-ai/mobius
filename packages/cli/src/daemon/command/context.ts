import type { WebSocket } from "undici";
import type { AgentRuntimeManager } from "../../acp/agent-runtime-manager.ts";
import type { WorkspaceDirectoryService } from "../../authorization/workspace-directory.ts";
import type { ExternalContentStore } from "../../external-content/local-external-content-store.ts";
import type { NativeSessionService } from "../../native-sessions/service.ts";
import type { RuntimeSessionEventProjection } from "../../session-event-projection.ts";
import type { RuntimeConfig } from "../config.ts";
import type { RelayConnectionDiagnostics } from "../relay/diagnostics.ts";
import type { RuntimeOperationState } from "../relay/runtime-operation-state.ts";
import type { Timer } from "../relay/timer.ts";
import type { RuntimeTurnRegistry } from "../turn-registry.ts";

export interface CommandContext {
    readonly config: RuntimeConfig;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: AgentRuntimeManager;
    readonly nativeSessions: NativeSessionService;
    readonly operations: RuntimeOperationState;
    readonly eventProjection: RuntimeSessionEventProjection;
    readonly externalContent: ExternalContentStore;
    readonly activeTurns: RuntimeTurnRegistry;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly socket: WebSocket;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}
