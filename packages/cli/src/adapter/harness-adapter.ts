import type { NativeSessionHistory, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AgentSession } from "../acp/agent-session.ts";
import type {
    AcpNativeEventReplayV2,
    AcpPrepareOptions,
    AcpSessionObserver,
    AcpSessionRecovery,
} from "../acp/session-contracts.ts";
import type { AcpSessionStore } from "../acp/session-store.ts";
import type { AcpContentExternalizer } from "../external-content/acp-content-externalizer.ts";
import type { OperationMetrics } from "../infra/operation-metrics.ts";

export type HarnessNativeHistoryAccess =
    | { readonly kind: "acp" }
    | {
          readonly kind: "direct";
          readonly read: (nativeSessionId: string) => Promise<NativeSessionHistory>;
      };

export interface HarnessNativeHistoryReader {
    readonly access: (options: AcpPrepareOptions) => HarnessNativeHistoryAccess;
}

export const acpHarnessNativeHistoryReader: HarnessNativeHistoryReader = {
    access: () => ({ kind: "acp" }),
};

export interface HarnessHistoryPageRequest {
    readonly cursor: string | null;
    readonly eventLimit: number;
    readonly options: AcpPrepareOptions;
    readonly readFromHarness: () => Promise<AcpNativeEventReplayV2>;
}

export interface HarnessHistoryPreviewRequest extends HarnessHistoryPageRequest {
    readonly nativeSessionId: string;
}

export interface HarnessLiveEventSubscription {
    readonly close: () => void;
}

export type HarnessLiveEventSubscriber = (event: SessionLiveEventV2) => Promise<void>;

interface HarnessSessionRequest {
    readonly contentExternalizer: AcpContentExternalizer;
    readonly getObserver: () => AcpSessionObserver;
    readonly options: AcpPrepareOptions;
    readonly store: AcpSessionStore;
}

export interface HarnessCreateSessionRequest extends HarnessSessionRequest {
    readonly authorizeNativeSessionId: (nativeSessionId: string) => void;
    readonly metrics: OperationMetrics;
}

export type HarnessOpenSessionRequest =
    | (HarnessSessionRequest & {
          readonly kind: "execution";
          readonly metrics: OperationMetrics;
          readonly recovery: AcpSessionRecovery;
      })
    | (HarnessSessionRequest & { readonly kind: "native-browser" });

export type OpenedSession = AgentSession;

export interface HarnessAdapter {
    readonly close: () => void;
    readonly createSession: (request: HarnessCreateSessionRequest) => Promise<OpenedSession>;
    readonly id: string;
    readonly openSession: (request: HarnessOpenSessionRequest) => Promise<OpenedSession>;
    readonly previewPageHistoryEvents: (request: HarnessHistoryPreviewRequest) => Promise<AcpNativeEventReplayV2>;
    readonly readPageHistoryEvents: (request: HarnessHistoryPageRequest) => Promise<AcpNativeEventReplayV2>;
    readonly subscribeLiveEvents: (subscriber: HarnessLiveEventSubscriber) => HarnessLiveEventSubscription;
}
