import type { ChannelRuntime } from "@moxt-ai/mobius-relay-core";

export class CloudflareChannelRuntime implements ChannelRuntime {
  private readonly namespace: DurableObjectNamespace;

  constructor(namespace: DurableObjectNamespace) {
    this.namespace = namespace;
  }

  readonly acceptDaemon = async (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> => await this.forward(channelId, request, signal);

  readonly acceptHost = async (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> => await this.forward(channelId, request, signal);

  readonly readHistory = async (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> => await this.forward(channelId, request, signal);

  private async forward(
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ): Promise<Response> {
    signal.throwIfAborted();
    const objectId = this.namespace.idFromName(channelId);
    const response = await this.namespace.get(objectId).fetch(request);
    signal.throwIfAborted();
    return response;
  }
}
