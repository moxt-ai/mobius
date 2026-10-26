import type { SessionCapabilities, SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionConfigProtocol } from "../../acp/protocol/session-config-protocol.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import type { SessionStore, StoredSession } from "../record/session-store.ts";

/**
 * The state and operations session restore needs. AgentSession implements it; keeping it
 * declared beside the class documents exactly what the restore decision tree may touch.
 */
/**
 * The state and operations session restore needs. AgentSession implements it; keeping it
 * declared beside the restore function documents exactly what the decision tree may touch.
 */
export interface AgentSessionRestore {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly capabilities: SessionCapabilities;
    readonly cwd: string;
    readonly metrics: OperationMetrics;
    readonly restored: boolean;
    readonly sessionId: string;
    readonly sessionConfigProtocol: SessionConfigProtocol;
    readonly store: SessionStore;
    agentRequest<Params, Result>(
        method: string,
        params: Params,
        options?: { cancellationSignal?: AbortSignal },
    ): Promise<Result>;
    drained(): Promise<void>;
    initializeAgent(signal: AbortSignal): Promise<void>;
    loadSession(signal: AbortSignal, exitMessage: string): Promise<{ response: unknown }>;
    nativeSessionId(): string;
    race<T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T>;
    restoreStoredConfigurations(session: StoredSession, signal: AbortSignal): Promise<void>;
    selectNativeSession(sessionId: string): void;
    readonly restrictSessionCapabilities: (response: unknown) => void;
    setConfigOptions(options: readonly SessionConfigOption[]): void;
    setNativeHistoryOwnership(
        ownership: { kind: "unbound" } | { kind: "fresh-session" } | { kind: "agent-owned" },
    ): void;
    startExecutionOnlyCapture(): void;
    setPrompted(prompted: boolean): void;
    setRestored(restored: boolean): void;
    setSessionTitle(title: string): void;
    writeStoredSession(updatedAt: string): void;
}
