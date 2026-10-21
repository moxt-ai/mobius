import { DurableObject } from "cloudflare:workers";
import {
    DurableObjectSqlDatabase,
    logger,
    RuntimeRelay as RuntimeRelayImplementation,
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
            logger.child({ durableObjectClass: "RuntimeRelay", durableObjectId: state.id.toString() }),
        );
    }

    override async fetch(request: Request): Promise<Response> {
        return await this.#runtime.fetch(request);
    }

    override async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        await this.#runtime.webSocketMessage(socket, message);
    }

    override async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        await this.#runtime.webSocketClose(socket, { code, reason, wasClean });
    }

    override webSocketError(socket: WebSocket, error: unknown): void {
        this.#runtime.webSocketError(socket, error);
    }
}
