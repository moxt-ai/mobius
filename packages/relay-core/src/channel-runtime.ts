import type { VerifiedChannelAccess } from "./pairing-directory.ts";

export interface ChannelRuntime {
  readonly acceptDaemon: (
    access: VerifiedChannelAccess,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly acceptHost: (
    access: VerifiedChannelAccess,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
}
