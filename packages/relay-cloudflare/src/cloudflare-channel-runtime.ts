import {
    type ChannelGateway,
    type ChannelHostCredential,
    RuntimeStatus,
    type VerifiedChannelAccess,
} from "@moxt-ai/mobius-relay-core";

const INTERNAL_CHANNEL_ID_HEADER = "x-mobius-channel-id";
const INTERNAL_HOST_CREDENTIAL_ID_HEADER = "x-mobius-host-credential-id";
const INTERNAL_PROJECT_ID_HEADER = "x-mobius-project-id";
const INTERNAL_RUNTIME_ID_HEADER = "x-mobius-runtime-id";
const INTERNAL_TENANT_ID_HEADER = "x-mobius-tenant-id";

export class CloudflareChannelRuntime implements ChannelGateway {
    readonly #namespace: DurableObjectNamespace;

    constructor(cx: { readonly gateways: { readonly runtimeRelay: DurableObjectNamespace } }) {
        this.#namespace = cx.gateways.runtimeRelay;
    }

    readonly acceptDaemon = async (
        access: VerifiedChannelAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => await this.forward(access, request, signal);

    readonly acceptHost = async (
        access: ChannelHostCredential,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        const headers = new Headers(request.headers);
        headers.set(INTERNAL_HOST_CREDENTIAL_ID_HEADER, access.credentialId);
        return await this.forward(access, new Request(request, { headers, signal }), signal);
    };

    readonly disconnectHost = async (access: ChannelHostCredential, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const headers = new Headers();
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_HOST_CREDENTIAL_ID_HEADER, access.credentialId);
        headers.set(INTERNAL_PROJECT_ID_HEADER, access.projectId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        headers.set(INTERNAL_TENANT_ID_HEADER, access.tenantId);
        const objectId = this.#namespace.idFromName(access.channelId);
        const response = await this.#namespace.get(objectId).fetch(
            new Request("https://runtime.internal/host-credentials/revoke", {
                headers,
                method: "DELETE",
                signal,
            }),
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
        headers.set(INTERNAL_PROJECT_ID_HEADER, access.projectId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        headers.set(INTERNAL_TENANT_ID_HEADER, access.tenantId);
        const objectId = this.#namespace.idFromName(access.channelId);
        const response = await this.#namespace.get(objectId).fetch(
            new Request("https://runtime.internal/runtime/revoke", {
                headers,
                method: "DELETE",
                signal,
            }),
        );
        signal.throwIfAborted();
        if (response.status !== 204) {
            throw new Error("The Runtime connection could not be revoked");
        }
    };

    readonly dispatchPending = async (access: VerifiedChannelAccess, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const headers = new Headers();
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_PROJECT_ID_HEADER, access.projectId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        headers.set(INTERNAL_TENANT_ID_HEADER, access.tenantId);
        const objectId = this.#namespace.idFromName(access.channelId);
        const response = await this.#namespace.get(objectId).fetch(
            new Request("https://runtime.internal/pending-daemon-deliveries", {
                headers,
                method: "POST",
                signal,
            }),
        );
        signal.throwIfAborted();
        if (response.status !== 204) {
            throw new Error("The pending Runtime work could not be dispatched");
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
        return new RuntimeStatus(Reflect.get(value, "online"));
    };

    private readonly forward = async (
        access: VerifiedChannelAccess,
        request: Request,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const headers = new Headers(request.headers);
        headers.set(INTERNAL_CHANNEL_ID_HEADER, access.channelId);
        headers.set(INTERNAL_PROJECT_ID_HEADER, access.projectId);
        headers.set(INTERNAL_TENANT_ID_HEADER, access.tenantId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, access.runtimeId);
        const forwarded = new Request(request, { headers, signal });
        const objectId = this.#namespace.idFromName(access.channelId);
        const response = await this.#namespace.get(objectId).fetch(forwarded);
        signal.throwIfAborted();
        return response;
    };
}
