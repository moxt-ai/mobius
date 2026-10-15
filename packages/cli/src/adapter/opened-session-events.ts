import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
    AcpSessionUpdateV2,
    NativeSessionHistory,
    SessionEventPayloadV2,
    SessionLiveEventV2,
} from "@moxt-ai/mobius-protocol";
import type { AcpNativeEventReplayV2 } from "../acp/session-contracts.ts";
import type { AcpSessionEventStoreV2 } from "../acp/session-event-store-v2.ts";
import { AcpHistoryReplay } from "../acp/session-history.ts";

export interface OpenedSessionEvents {
    readonly close: () => void;
    readonly completeTurn: () => Promise<void>;
    readonly historyEventPage: (eventLimit: number, cursor: string | null) => AcpNativeEventReplayV2;
    readonly historySnapshot: () => Promise<NativeSessionHistory>;
    readonly recordHistoryUpdate: (
        update: SessionNotification["update"],
        rawUpdate: AcpSessionUpdateV2,
    ) => Promise<void>;
    readonly recordLifecycleEvent: (event: SessionEventPayloadV2) => Promise<void>;
    readonly recordLiveUpdate: (update: SessionNotification["update"], rawUpdate: AcpSessionUpdateV2) => Promise<void>;
    readonly startHistoryLoad: () => void;
    readonly startTurn: () => void;
}

type OpenedSessionHistoryState =
    | { readonly kind: "closed" }
    | { readonly kind: "empty" }
    | { readonly history: AcpHistoryReplay; readonly kind: "history" }
    | { readonly history: AcpHistoryReplay; readonly kind: "turn"; readonly turn: AcpHistoryReplay };

export class AdapterOpenedSessionEvents implements OpenedSessionEvents {
    readonly #events: AcpSessionEventStoreV2;
    readonly #onClose: (sessionId: string) => void;
    readonly #publishLiveEvent: (event: SessionLiveEventV2) => Promise<void>;
    readonly #sessionId: string;
    #state: OpenedSessionHistoryState = { kind: "empty" };

    constructor(
        events: AcpSessionEventStoreV2,
        sessionId: string,
        publishLiveEvent: (event: SessionLiveEventV2) => Promise<void>,
        onClose: (sessionId: string) => void,
    ) {
        this.#events = events;
        this.#sessionId = sessionId;
        this.#publishLiveEvent = publishLiveEvent;
        this.#onClose = onClose;
    }

    readonly #history = (): AcpHistoryReplay => {
        if (this.#state.kind === "history" || this.#state.kind === "turn") {
            return this.#state.history;
        }
        throw new Error("The harness session history is unavailable");
    };

    readonly startHistoryLoad = (): void => {
        if (this.#state.kind === "closed") {
            throw new Error("The harness session is closed");
        }
        this.#events.reset(this.#sessionId);
        this.#state = { history: new AcpHistoryReplay(this.#events, this.#sessionId), kind: "history" };
    };

    readonly startTurn = (): void => {
        const history = this.#history();
        if (this.#state.kind === "turn") {
            throw new Error("The harness session turn is already open");
        }
        this.#state = {
            history,
            kind: "turn",
            turn: new AcpHistoryReplay(this.#events, this.#sessionId),
        };
    };

    readonly completeTurn = async (): Promise<void> => {
        if (this.#state.kind !== "turn") {
            throw new Error("The harness session turn is not open");
        }
        const { history, turn } = this.#state;
        await history.append(turn);
        this.#state = { history, kind: "history" };
    };

    readonly recordHistoryUpdate = async (
        update: SessionNotification["update"],
        rawUpdate: AcpSessionUpdateV2,
    ): Promise<void> => {
        await this.#history().record(update, rawUpdate);
    };

    readonly recordLiveUpdate = async (
        update: SessionNotification["update"],
        rawUpdate: AcpSessionUpdateV2,
    ): Promise<void> => {
        const replay = this.#state.kind === "turn" ? this.#state.turn : this.#history();
        await replay.record(update, rawUpdate, this.#publishLiveEvent);
    };

    readonly recordLifecycleEvent = async (event: SessionEventPayloadV2): Promise<void> => {
        const replay = this.#state.kind === "turn" ? this.#state.turn : this.#history();
        await this.#publishLiveEvent(replay.recordLifecycle(event));
    };

    readonly historySnapshot = async (): Promise<NativeSessionHistory> => await this.#history().snapshot();

    readonly historyEventPage = (eventLimit: number, cursor: string | null): AcpNativeEventReplayV2 =>
        this.#history().eventPage(eventLimit, cursor);

    readonly close = (): void => {
        if (this.#state.kind === "closed") {
            return;
        }
        this.#state = { kind: "closed" };
        this.#onClose(this.#sessionId);
    };

    readonly shutdown = (): void => {
        this.#state = { kind: "closed" };
    };
}
