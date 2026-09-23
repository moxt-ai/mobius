import {
    createDurableObjectContext,
    RuntimeRelay as RuntimeRelayImplementation,
    type SessionEventReceiver,
} from "@moxt-ai/mobius-relay-core";
import { StandaloneDatabaseResolver } from "./standalone-database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "./standalone-project-storage-directory.ts";

export interface StandaloneDurableObjectEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createStandaloneDurableObjectContext(
    state: DurableObjectState,
    environment: StandaloneDurableObjectEnvironment,
) {
    return createDurableObjectContext(state, {
        databases: new StandaloneDatabaseResolver(environment.DIRECTORY_DATABASE),
        projects: new StandaloneProjectStorageDirectory(),
    });
}

export class RuntimeRelay extends DurableObject<StandaloneDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;

    constructor(state: DurableObjectState, environment: StandaloneDurableObjectEnvironment) {
        super(state, environment);
        this.#runtime = new RuntimeRelayImplementation(createStandaloneDurableObjectContext(state, environment));
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

import { DurableObject } from "cloudflare:workers";
