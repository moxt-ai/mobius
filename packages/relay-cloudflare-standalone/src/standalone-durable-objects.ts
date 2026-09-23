import {
    createDurableObjectContext,
    type DoSqlDatabase,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { StandaloneDatabaseResolver } from "./standalone-database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "./standalone-project-storage-directory.ts";
import { StandaloneSessionHost } from "./standalone-session-host.ts";

export interface StandaloneDurableObjectEnvironment extends LiteSessionConfigurationEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createStandaloneDurableObjectContext(
    state: DurableObjectState,
    environment: StandaloneDurableObjectEnvironment,
    doDatabase?: DoSqlDatabase,
) {
    return createDurableObjectContext(state, {
        environment,
        runtimeRelay: environment.RUNTIME_RELAY,
        databases: new StandaloneDatabaseResolver(environment.DIRECTORY_DATABASE),
        projects: new StandaloneProjectStorageDirectory(),
        content: { kind: "sqlite" },
        ...(doDatabase === undefined ? {} : { doDatabase }),
    });
}

export class RuntimeRelay extends DurableObject<StandaloneDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;
    readonly #sessions: StandaloneSessionHost;

    constructor(state: DurableObjectState, environment: StandaloneDurableObjectEnvironment) {
        super(state, environment);
        this.#runtime = new RuntimeRelayImplementation(createStandaloneDurableObjectContext(state, environment));
        this.#sessions = new StandaloneSessionHost(state, environment);
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
        receive: Parameters<StandaloneSessionHost["subscribeToLiveSessionEvents"]>[4],
    ): Promise<void> {
        await this.#sessions.subscribeToLiveSessionEvents(subscriptionId, projectId, runtimeId, sessionId, receive);
    }

    unsubscribeFromLiveSessionEvents(subscriptionId: string): void {
        this.#sessions.unsubscribeFromLiveSessionEvents(subscriptionId);
    }
}

import { DurableObject } from "cloudflare:workers";
