import type { RuntimeAccessContext } from "../entity/authentication/project-authentication.ts";
import type { ChannelHostCredential, VerifiedChannelAccess } from "../entity/pairing/pairing.ts";
import { requestLogContext } from "../infra/log-diagnostics.ts";
import { logger } from "../infra/logger.ts";
import { RuntimeStatus } from "../service/channel/channel.ts";
import type { ChannelGateway } from "./channel-gateway.ts";

const INTERNAL_CHANNEL_ID_HEADER = "x-mobius-channel-id";
const INTERNAL_HOST_CREDENTIAL_ID_HEADER = "x-mobius-host-credential-id";
const INTERNAL_RUNTIME_ID_HEADER = "x-mobius-runtime-id";

export class CloudflareChannelRuntime implements ChannelGateway {
    readonly #namespace: DurableObjectNamespace;

    constructor(cx: { readonly gateways: { readonly runtimeRelay: DurableObjectNamespace } }) {
        this.#namespace = cx.gateways.runtimeRelay;
    }

    readonly acceptDaemon = async (
        access: RuntimeAccessContext,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const endpoint = new URL(request.url);
        endpoint.pathname = "/daemon";
        return await this.forward(
            access,
            new Request(endpoint, { headers: request.headers, method: request.method, signal }),
            signal,
        );
    };

    readonly acceptHost = async (
        access: ChannelHostCredential,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const headers = new Headers(request.headers);
        headers.set(INTERNAL_HOST_CREDENTIAL_ID_HEADER, access.credentialId);
        const endpoint = new URL(request.url);
        // Public viewers cannot opt into the private request-reply routing mode.
        endpoint.searchParams.delete("nativeRequestId");
        return await this.forward(access, new Request(endpoint, { headers, method: request.method, signal }), signal);
    };

    readonly acceptNativeRequest = async (
        access: ChannelHostCredential,
        requestId: string,
        signal: AbortSignal,
    ): Promise<Response> => {
        const endpoint = new URL("https://runtime.internal/host");
        endpoint.searchParams.set("nativeRequestId", requestId);
        return await this.forward(
            access,
            new Request(endpoint, {
                headers: { Upgrade: "websocket", [INTERNAL_HOST_CREDENTIAL_ID_HEADER]: access.credentialId },
                signal,
            }),
            signal,
        );
    };

    readonly disconnectHost = async (access: ChannelHostCredential, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const headers = new Headers();
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_HOST_CREDENTIAL_ID_HEADER, access.credentialId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        const response = await this.fetchRuntime(
            access,
            new Request(
                `https://runtime.internal/projects/${encodeURIComponent(access.projectId)}/host-credentials/revoke`,
                {
                    headers,
                    method: "DELETE",
                    signal,
                },
            ),
            signal,
        );
        signal.throwIfAborted();
        if (response.status !== 204) {
            throw new Error("The linked host connection could not be revoked");
        }
    };

    readonly disconnectRuntime = async (access: VerifiedChannelAccess, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const headers = new Headers();
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        const response = await this.fetchRuntime(
            access,
            new Request(`https://runtime.internal/projects/${encodeURIComponent(access.projectId)}/runtime/revoke`, {
                headers,
                method: "DELETE",
                signal,
            }),
            signal,
        );
        signal.throwIfAborted();
        if (response.status !== 204) {
            throw new Error("The Runtime connection could not be revoked");
        }
    };

    readonly readRuntimeStatus = async (access: VerifiedChannelAccess, signal: AbortSignal): Promise<RuntimeStatus> => {
        const response = await this.forward(
            access,
            new Request("https://runtime.internal/runtime-status", {
                method: "GET",
                signal,
            }),
            signal,
        );
        if (!response.ok) {
            throw new Error("The Runtime status could not be read");
        }
        const value: unknown = await response.json();
        if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            typeof Reflect.get(value, "online") !== "boolean"
        ) {
            throw new Error("The Runtime returned an invalid status");
        }
        return new RuntimeStatus(Reflect.get(value, "online"), Reflect.get(value, "nativeForkRecovery") === true);
    };

    private readonly forward = async (
        access: VerifiedChannelAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const headers = new Headers(request.headers);
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        const endpoint = new URL(request.url);
        endpoint.pathname = `/projects/${encodeURIComponent(access.projectId)}${endpoint.pathname}`;
        const forwarded = new Request(endpoint, { method: request.method, headers, signal });
        return await this.fetchRuntime(access, forwarded, signal);
    };

    private readonly fetchRuntime = async (
        access: VerifiedChannelAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const objectId = this.#namespace.idFromName(access.runtimeId);
        try {
            const response = await this.#namespace.get(objectId).fetch(request.url, request);
            signal.throwIfAborted();
            return response;
        } catch (error) {
            logger.error(
                {
                    ...requestLogContext(request),
                    event: "runtime_relay_request_failed",
                    durableObjectClass: "RuntimeRelay",
                    durableObjectId: objectId.toString(),
                    projectId: access.projectId,
                    channelId: access.channelId,
                    runtimeId: access.runtimeId,
                    err: error,
                },
                "Runtime Relay request failed",
            );
            throw error;
        }
    };
}
