import { DurableObject } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay as RuntimeRelayImplementation } from "@moxt-ai/mobius-relay-core";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";
import { PlatformSessionHost } from "./platform-session-host.ts";

export class RuntimeRelay extends DurableObject<PlatformDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;
    #sessions: PlatformSessionHost | null = null;

    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(state, environment);
        this.#runtime = new RuntimeRelayImplementation(
            createPlatformDurableObjectContext(state, environment, {
                database: new DurableObjectSqlDatabase(state.storage),
            }),
        );
    }

    private readonly sessionHost = (): PlatformSessionHost => {
        this.#sessions ??= new PlatformSessionHost(this.ctx, this.env);
        return this.#sessions;
    };

    override async fetch(request: Request): Promise<Response> {
        return new URL(request.url).pathname.startsWith("/internal/projects/")
            ? await this.sessionHost().fetch(request)
            : await this.#runtime.fetch(request);
    }

    override async alarm(): Promise<void> {
        const failures: unknown[] = [];
        try {
            await this.#runtime.alarm();
        } catch (cause) {
            failures.push(cause);
        }
        if (this.#sessions !== null) {
            try {
                await this.#sessions.alarm();
            } catch (cause) {
                failures.push(cause);
            }
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
        await this.sessionHost().subscribeToLiveSessionEvents(subscriptionId, projectId, runtimeId, sessionId, receive);
    }

    unsubscribeFromLiveSessionEvents(subscriptionId: string): void {
        this.#sessions?.unsubscribeFromLiveSessionEvents(subscriptionId);
    }
}
