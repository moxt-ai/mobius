import {
    MOBIUS_API_PREFIX,
    MOBIUS_API_VERSION,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
    MOBIUS_SESSION_EVENT_STREAM_TRANSPORT,
    MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
    parseMobiusApiPrefix,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";

import { createChannelRoutes } from "./http/channel-routes.ts";
import { createPairingRoutes } from "./http/pairing-routes.ts";
import { createSessionRoutes } from "./http/session-routes.ts";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
} from "./pairing-directory.ts";
import { type RelayPorts, RelayUseCases } from "./relay-use-cases.ts";

export type RelayDependencies = RelayPorts;

export class MobiusApplication extends Hono {
    static readonly inject = ["useCases", "apiPrefix"] satisfies readonly ["useCases", "apiPrefix"];

    constructor(useCases: RelayUseCases, apiPrefix: string) {
        super();

        const api = new Hono();
        api.get("/health", (context) =>
            context.json({
                service: "mobius-relay",
                status: "ok",
            }),
        );
        api.get("/capabilities", (context) =>
            context.json({
                apiVersion: MOBIUS_API_VERSION,
                artifacts: {
                    downloadTransport: "authorized-stream",
                    uploadProtocol: "two-stage",
                },
                authentication: {
                    browserCredentials: true,
                    maximumBrowserCredentialLifetimeSeconds: MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000,
                    minimumBrowserCredentialLifetimeSeconds: MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000,
                },
                portability: {
                    exportFormatVersion: MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
                    nativeContextImport: false,
                    targetBindingRequired: true,
                },
                resources: {
                    artifacts: true,
                    attempts: true,
                    browserCredentials: true,
                    events: true,
                    interactions: true,
                    messages: true,
                    portability: true,
                    runtimes: true,
                    sessions: true,
                    toolCalls: true,
                    turns: true,
                },
                sessionEvents: {
                    eventName: MOBIUS_SESSION_EVENT_STREAM_EVENT,
                    formatVersion: MOBIUS_EVENT_FORMAT_VERSION,
                    mediaType: MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
                    transport: MOBIUS_SESSION_EVENT_STREAM_TRANSPORT,
                },
            }),
        );
        api.route("/pairings", createPairingRoutes(useCases.pairings));
        api.route("/channels", createChannelRoutes(useCases.channels));
        api.route("/", createSessionRoutes(useCases.sessions));

        this.route(parseMobiusApiPrefix(apiPrefix), api);
    }
}

export function createRelayApp(dependencies: RelayDependencies, apiPrefix: string = MOBIUS_API_PREFIX): Hono {
    return new MobiusApplication(
        new RelayUseCases(dependencies.channelRuntime, dependencies.pairingDirectory, dependencies.sessionRuntime),
        apiPrefix,
    );
}
