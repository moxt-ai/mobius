import { DurableObject } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay as RuntimeRelayImplementation } from "@moxt-ai/mobius-relay-core";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";
import { PlatformSessionHost } from "./platform-session-host.ts";

export class RuntimeRelay extends DurableObject<PlatformDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;
    readonly #sessions: PlatformSessionHost;

    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(state, environment);
        this.#runtime = new RuntimeRelayImplementation(
            createPlatformDurableObjectContext(state, environment, {
                database: new DurableObjectSqlDatabase(state.storage),
            }),
        );
        this.#sessions = new PlatformSessionHost(state, environment);
    }

    override async fetch(request: Request): Promise<Response> {
        return new URL(request.url).pathname.startsWith("/internal/projects/")
            ? await this.#sessions.fetch(request)
            : await this.#runtime.fetch(request);
    }

    override async alarm(): Promise<void> {
        const failures: unknown[] = [];
        try {
            await this.#runtime.alarm();
        } catch (cause) {
            failures.push(cause);
        }
        try {
            await this.#sessions.alarm();
        } catch (cause) {
            failures.push(cause);
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "The Runtime relay could not recover");
        }
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
        receive: Parameters<PlatformSessionHost["subscribeToLiveSessionEvents"]>[4],
    ): Promise<void> {
        await this.#sessions.subscribeToLiveSessionEvents(subscriptionId, projectId, runtimeId, sessionId, receive);
    }

    unsubscribeFromLiveSessionEvents(subscriptionId: string): void {
        this.#sessions.unsubscribeFromLiveSessionEvents(subscriptionId);
    }
}
