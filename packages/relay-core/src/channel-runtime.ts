import type {
  ChannelHostCredential,
  VerifiedChannelAccess,
} from "./pairing-directory.ts";

export interface ChannelRuntime {
  readonly acceptDaemon: (
    access: VerifiedChannelAccess,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly acceptHost: (
    access: ChannelHostCredential,
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly disconnectHost: (
    access: ChannelHostCredential,
    signal: AbortSignal,
  ) => Promise<void>;
}
