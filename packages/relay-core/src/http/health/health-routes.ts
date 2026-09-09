import {
    MOBIUS_API_VERSION,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
    MOBIUS_SESSION_EVENT_STREAM_TRANSPORT,
    MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
} from "../../service/pairing/pairing.ts";

interface HealthResponse {
    readonly service: "mobius-relay";
    readonly status: "ok";
}

export function createHealthRoutes() {
    return new Hono()
        .get("/health", (context) =>
            context.json<HealthResponse>({
                service: "mobius-relay",
                status: "ok",
            }),
        )
        .get("/capabilities", (context) =>
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
                    runtimePairings: true,
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
}
