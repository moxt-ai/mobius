import type { NativeSessionHistory, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplayV2, AcpPrepareOptions } from "../acp/session-contracts.ts";
import type { AcpHistoryReplay } from "../acp/session-history.ts";

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

export interface HarnessSessionEvents {
    readonly createHistoryReplay: (sessionId: string) => AcpHistoryReplay;
    readonly publishLiveEvent: (event: SessionLiveEventV2) => Promise<void>;
    readonly removeHistoryEvents: (sessionId: string) => void;
    readonly resetHistoryEvents: (sessionId: string) => void;
}

export interface HarnessAdapter extends HarnessSessionEvents {
    readonly close: () => void;
    readonly id: string;
    readonly previewPageHistoryEvents: (request: HarnessHistoryPreviewRequest) => Promise<AcpNativeEventReplayV2>;
    readonly readPageHistoryEvents: (request: HarnessHistoryPageRequest) => Promise<AcpNativeEventReplayV2>;
    readonly subscribeLiveEvents: (subscriber: HarnessLiveEventSubscriber) => HarnessLiveEventSubscription;
}
