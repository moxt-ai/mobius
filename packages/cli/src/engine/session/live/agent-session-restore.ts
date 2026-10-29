import type { SessionCapabilities, SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import type { AdapterSessionOpened } from "../../acp/native-history/preview-contract.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import type { SessionStore, StoredSession } from "../record/session-store.ts";

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
    readonly store: SessionStore;
    readonly createSession: (signal: AbortSignal) => Promise<AdapterSessionOpened>;
    readonly forkSession: (sourceSessionId: string, signal: AbortSignal) => Promise<AdapterSessionOpened>;
    readonly openSession: (signal: AbortSignal) => Promise<AdapterSessionOpened>;
    readonly openSessionWithReplay: (signal: AbortSignal) => Promise<AdapterSessionOpened>;
    nativeSessionId(): string;
    readonly restoreStoredConfigurations: (
        session: StoredSession,
        signal: AbortSignal,
        intent?: "restore" | "fork",
    ) => Promise<void>;
    selectNativeSession(sessionId: string): void;
    readonly applySessionOpened: (opened: AdapterSessionOpened) => void;
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
