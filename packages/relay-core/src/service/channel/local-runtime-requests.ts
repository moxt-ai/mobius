import { logger } from "../../infra/logger.ts";
import type { RuntimeReplyConnection } from "../pairing/runtime-control-request.ts";
import type { ChannelPeers, ChannelSocket, HistoryRequestKind } from "./channel-actor.ts";

export class LocalRuntimeRequest extends EventTarget implements RuntimeReplyConnection {
    #state: number = WebSocket.OPEN;
    readonly #dispatch: (socket: ChannelSocket, message: unknown) => Promise<void>;
    readonly #release: () => void;
    readonly server: ChannelSocket;

    constructor(dispatch: (socket: ChannelSocket, message: unknown) => Promise<void>, release: () => void) {
        super();
        this.#dispatch = dispatch;
        this.#release = release;
        let history: { readonly kind: HistoryRequestKind; readonly requestId: string } | null = null;
        const discoveries = new Map<string, string>();
        this.server = {
            close: (code, reason) => this.close(code, reason),
            send: (message) => {
                if (this.isOpen()) {
                    this.dispatchEvent(new MessageEvent("message", { data: message }));
                }
            },
            isOpen: () => this.isOpen(),
            isSame: (socket) => socket === this.server,
            permitsSessionHistory: () => true,
            bindHistoryRequest: (kind, requestId) => {
                history = { kind, requestId };
            },
            matchesHistoryRequest: (kind, requestId) => history?.kind === kind && history.requestId === requestId,
            trackAgentSettingsDiscovery: (requestId, agentId) => {
                const existing = discoveries.get(requestId);
                if (existing !== undefined) {
                    return existing === agentId ? "duplicate" : "busy";
                }
                if (discoveries.size >= 4) {
                    return "busy";
                }
                discoveries.set(requestId, agentId);
                return "tracked";
            },
            consumeAgentSettingsDiscovery: (requestId, agentId) => {
                if (discoveries.get(requestId) !== agentId) {
                    return false;
                }
                return discoveries.delete(requestId);
            },
            consumeAgentSettingsDiscoveryFailure: (requestId) => discoveries.delete(requestId),
            takeAgentSettingsDiscoveries: () => {
                const ids = [...discoveries.keys()];
                discoveries.clear();
                return ids;
            },
        };
    }
    get readyState(): number {
        return this.#state;
    }
    private readonly isOpen = () => this.#state === WebSocket.OPEN;
    readonly accept = (): void => {};
    readonly send = (message: string | ArrayBuffer | ArrayBufferView): void => {
        if (!this.isOpen()) {
            throw new Error("The Runtime request is closed");
        }
        void this.#dispatch(this.server, message).catch((cause: unknown) => {
            logger.error({ err: cause, event: "runtime_local_request_failed" }, "Runtime local request failed");
            this.dispatchEvent(new Event("error"));
            this.close();
        });
    };
    readonly close = (_code?: number, _reason?: string): void => {
        if (!this.isOpen()) {
            return;
        }
        this.#state = WebSocket.CLOSED;
        this.#release();
        this.dispatchEvent(new Event("close"));
    };
}

export class LocalRuntimeRequests {
    readonly #routes = new Set<ReturnType<ChannelPeers["operations"]>[number]>();
    readonly routes = () => [...this.#routes];
    readonly open = (
        requestId: string,
        sessionId: string,
        queueAcknowledgement: boolean,
        dispatch: (socket: ChannelSocket, message: unknown) => Promise<void>,
    ) => {
        const connection = new LocalRuntimeRequest(dispatch, () => this.#routes.delete(route));
        const route = { socket: connection.server, requestId, sessionId, queueAcknowledgement };
        this.#routes.add(route);
        return connection;
    };
}
