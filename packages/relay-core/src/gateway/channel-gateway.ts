import type { RuntimeStatus } from "../service/channel/channel.ts";
import type { ChannelHostCredential, VerifiedChannelAccess } from "../service/pairing/pairing.ts";
export interface ChannelGateway {
    readonly acceptDaemon: (access: VerifiedChannelAccess, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly acceptHost: (access: ChannelHostCredential, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectHost: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
    readonly dispatchPending: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<RuntimeStatus>;
}
