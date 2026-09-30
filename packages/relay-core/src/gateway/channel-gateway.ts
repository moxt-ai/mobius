import type { RuntimeAccessContext } from "../entity/authentication/project-authentication.ts";
import type { ChannelHostCredential, VerifiedChannelAccess } from "../entity/pairing/pairing.ts";
import type { RecordingDeliveryMetricsSnapshot } from "../infra/recording-delivery-metrics.ts";
import type { RuntimeStatus } from "../service/channel/channel.ts";

export interface ChannelGateway {
    readonly acceptDaemon: (access: RuntimeAccessContext, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly acceptHost: (access: ChannelHostCredential, request: Request, signal: AbortSignal) => Promise<Response>;
    readonly disconnectHost: (access: ChannelHostCredential, signal: AbortSignal) => Promise<void>;
    readonly disconnectRuntime: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<void>;
    readonly readRuntimeStatus: (access: VerifiedChannelAccess, signal: AbortSignal) => Promise<RuntimeStatus>;
    readonly readRecordingMetrics: (
        access: VerifiedChannelAccess,
        signal: AbortSignal,
    ) => Promise<RecordingDeliveryMetricsSnapshot>;
}
