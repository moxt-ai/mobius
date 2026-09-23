import { DurableObject } from "cloudflare:workers";
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
        _subscriptionId: string,
        _projectId: string,
        _runtimeId: string,
        _sessionId: string,
        _receive: SessionEventReceiver,
    ): Promise<void> {
        throw new Error("Cloud Session subscriptions are unavailable.");
    }

    unsubscribeFromLiveSessionEvents(_subscriptionId: string): void {
        return;
    }
}
