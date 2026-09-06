import type {
  ChannelRuntime,
  VerifiedChannelAccess,
} from "@moxt-ai/mobius-relay-core";

export const INTERNAL_CHANNEL_ID_HEADER = "x-mobius-channel-id";
export const INTERNAL_PROJECT_ID_HEADER = "x-mobius-project-id";
export const INTERNAL_TENANT_ID_HEADER = "x-mobius-tenant-id";

export class CloudflareChannelRuntime implements ChannelRuntime {
  readonly #namespace: DurableObjectNamespace;

  constructor(namespace: DurableObjectNamespace) {
    this.#namespace = namespace;
  }

  readonly acceptDaemon = async (
    access: VerifiedChannelAccess,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> => await this.forward(access, request, signal);

  readonly acceptHost = async (
    access: VerifiedChannelAccess,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> => await this.forward(access, request, signal);

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
    const forwarded = new Request(request, { headers, signal });
    const objectId = this.#namespace.idFromName(access.channelId);
    const response = await this.#namespace.get(objectId).fetch(forwarded);
    signal.throwIfAborted();
    return response;
  };
}
