export interface ChannelRuntime {
  readonly acceptDaemon: (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly acceptHost: (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly readHistory: (
    channelId: string,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
}
