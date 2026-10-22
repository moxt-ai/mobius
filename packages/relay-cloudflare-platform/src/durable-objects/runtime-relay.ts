import { DurableObject } from "cloudflare:workers";
import {
    createLocalSessionOperations,
    DurableObjectSqlDatabase,
    logger,
    RuntimeRelay as RuntimeRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { RUNTIME_HEARTBEAT_ACK_MESSAGE, RUNTIME_HEARTBEAT_MESSAGE } from "@moxt-ai/mobius-sdk/protocol";
import { runtimeRequestTarget } from "../gateway/runtime-session-routing.ts";
import { type ConfiguredPlatformRelayBindings, createPlatformWorker } from "../platform-worker.ts";
import { createPlatformDurableObjectContext } from "./platform-durable-object-context.ts";

export class RuntimeRelay extends DurableObject<ConfiguredPlatformRelayBindings> {
    readonly #runtime: RuntimeRelayImplementation;
    readonly #context: ReturnType<typeof createPlatformDurableObjectContext>;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #application = createPlatformWorker();
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#state = state;
        // Cloudflare answers daemon heartbeats itself, so an idle Runtime connection never wakes this object.
        state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair(RUNTIME_HEARTBEAT_MESSAGE, RUNTIME_HEARTBEAT_ACK_MESSAGE),
        );
        this.#context = createPlatformDurableObjectContext(state, environment, {
            database: new DurableObjectSqlDatabase(state.storage),
        });
        this.#runtime = new RuntimeRelayImplementation(
            this.#context,
            logger.child({ durableObjectClass: "RuntimeRelay", durableObjectId: state.id.toString() }),
        );
    }

    override async fetch(request: Request): Promise<Response> {
        const current = runtimeRequestTarget(request);
        if (current !== null) {
            const response = await this.#application.fetch(request, {
                ...this.#environment,
                MOBIUS_RUNTIME_EXECUTION: {
                    projectId: current.projectId,
                    runtimeId: current.runtimeId,
                    operations: createLocalSessionOperations(this.#context, current.projectId, current.runtimeId),
                },
            });
            if (response.status === 101) {
                await this.scheduleViewerExpiry();
            }
            return response;
        }
        return await this.#runtime.fetch(request);
    }

    private readonly scheduleViewerExpiry = async (): Promise<void> => {
        const viewers = this.#context.gateways.peers.viewers().filter(({ socket }) => socket.isOpen());
        if (viewers.length > 0) {
            await this.#state.storage.setAlarm(Math.min(...viewers.map(({ expiresAt }) => expiresAt)));
        } else {
            await this.#state.storage.deleteAlarm();
        }
    };

    override async alarm(): Promise<void> {
        for (const viewer of this.#context.gateways.peers.viewers()) {
            if (viewer.expiresAt <= Date.now()) {
                viewer.socket.close(1000, "Session access expired");
            }
        }
        await this.scheduleViewerExpiry();
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
