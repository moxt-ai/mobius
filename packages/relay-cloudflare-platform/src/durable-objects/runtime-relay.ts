import { DurableObject } from "cloudflare:workers";
import { isIdentifier } from "@moxt-ai/mobius-protocol";
import {
    CloudflareChannelPeers,
    DurableObjectSqlDatabase,
    RuntimeRelay as RuntimeRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { UpgradeErrorReporting } from "../gateway/upgrade-error-reporting.ts";
import { RuntimeUpgradeService } from "../service/runtime-upgrade-service.ts";
import { AppUpgradeStorage } from "../storage/app-upgrade-storage.ts";
import { RuntimeUpgradeStorage } from "../storage/runtime-upgrade-storage.ts";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";

export class RuntimeRelay extends DurableObject<PlatformDurableObjectEnvironment> {
    readonly #runtime: RuntimeRelayImplementation;
    readonly #upgrades: RuntimeUpgradeService;

    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(state, environment);
        const database = new DurableObjectSqlDatabase(state.storage);
        // The runtime context initializes the shared connection migrations before use.
        this.#upgrades = new RuntimeUpgradeService(
            new CloudflareChannelPeers(state),
            new RuntimeUpgradeStorage(database),
            new AppUpgradeStorage(environment),
            new UpgradeErrorReporting(environment.SENTRY_DSN),
            (promise) => state.waitUntil(promise),
        );
        this.#runtime = new RuntimeRelayImplementation(
            createPlatformDurableObjectContext(state, environment, {
                database,
                management: this.#upgrades,
            }),
        );
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.hostname === "runtime.internal" && url.pathname === "/upgrade-management") {
            const runtimeId = url.searchParams.get("runtimeId"),
                projectId = url.searchParams.get("projectId");
            if (
                !isIdentifier(runtimeId) ||
                !isIdentifier(projectId) ||
                this.env.RUNTIME_RELAY.idFromName(runtimeId).toString() !== this.ctx.id.toString()
            ) {
                return new Response(null, { status: 400 });
            }
            if (request.method === "POST") {
                await this.#upgrades.check(runtimeId, projectId, request.signal, true);
            }
            return Response.json(this.#upgrades.snapshot(runtimeId, projectId));
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
}
