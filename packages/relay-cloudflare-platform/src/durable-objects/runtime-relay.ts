import { DurableObject } from "cloudflare:workers";
import { decodeCommittedSessionEvent, decodeMessageKind, RUNTIME_STATUS_KIND } from "@moxt-ai/mobius-protocol";
import {
    DurableObjectSqlDatabase,
    RuntimeRelay as RuntimeRelayImplementation,
    type SessionEventReceiver,
} from "@moxt-ai/mobius-relay-core";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";

export class RuntimeRelay extends DurableObject<PlatformDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;
    readonly #liveSubscriptions = new Map<string, { readonly complete: () => void; readonly socket: WebSocket }>();

    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(state, environment);
        this.#runtime = new RuntimeRelayImplementation(
            createPlatformDurableObjectContext(state, environment, {
                database: new DurableObjectSqlDatabase(state.storage),
            }),
        );
    }

    override async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname.startsWith("/internal/projects/")) {
            return Response.json(
                { error: { code: "session_unavailable", message: "Cloud Sessions are unavailable." } },
                { status: 410 },
            );
        }
        return await this.#runtime.fetch(request);
    }

    override async alarm(): Promise<void> {
        await this.#runtime.alarm();
    }

    override async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        await this.#runtime.webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket): Promise<void> {
        await this.#runtime.webSocketClose(socket);
    }

    override webSocketError(socket: WebSocket): void {
        this.#runtime.webSocketError(socket);
    }

    async subscribeToLiveSessionEvents(
        subscriptionId: string,
        projectId: string,
        runtimeId: string,
        sessionId: string,
        receive: SessionEventReceiver,
    ): Promise<void> {
        this.unsubscribeFromLiveSessionEvents(subscriptionId);
        const response = await this.#runtime.openLiveSessionEventSocket(
            subscriptionId,
            projectId,
            runtimeId,
            AbortSignal.timeout(15_000),
        );
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("The Runtime live event socket is unavailable");
        }
        let complete = (): void => undefined;
        const completed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        let deliveries = Promise.resolve();
        let ready = false;
        const close = (): void => {
            deliveries = deliveries.then(async () => await receive.receive({ kind: "end" }));
            void deliveries.finally(complete);
        };
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }
            const kind = decodeMessageKind(event.data);
            if (kind === RUNTIME_STATUS_KIND && !ready) {
                ready = true;
                deliveries = deliveries.then(async () => await receive.receive({ kind: "ready" }));
                return;
            }
            if (kind !== "session.event.committed") {
                return;
            }
            const committed = decodeCommittedSessionEvent(event.data);
            if (committed.sessionId === sessionId) {
                deliveries = deliveries.then(async () => await receive.receive({ event: committed, kind: "event" }));
            }
        });
        socket.addEventListener("close", close, { once: true });
        socket.addEventListener("error", close, { once: true });
        this.#liveSubscriptions.set(subscriptionId, { complete, socket });
        socket.accept();
        try {
            await completed;
            await deliveries;
        } finally {
            const current = this.#liveSubscriptions.get(subscriptionId);
            if (current?.socket === socket) {
                this.#liveSubscriptions.delete(subscriptionId);
            }
        }
    }

    unsubscribeFromLiveSessionEvents(subscriptionId: string): void {
        const subscription = this.#liveSubscriptions.get(subscriptionId);
        if (subscription === undefined) {
            return;
        }
        this.#liveSubscriptions.delete(subscriptionId);
        subscription.socket.close(1000, "Subscription closed");
        subscription.complete();
    }
}
