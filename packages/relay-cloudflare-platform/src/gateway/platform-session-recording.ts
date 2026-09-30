import {
    encodeSessionRecordingWrite,
    isIdentifier,
    type ReliableSessionEventEnvelope,
    SessionEventRejectionCode,
} from "@moxt-ai/mobius-protocol";
import type {
    SessionRecording,
    SessionRecordingDeliveryResult,
    SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

const RECORDING_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_RETRY_AFTER_MILLISECONDS = 1_000;

export type RecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

function retryAfter(response: Response): number {
    const value = response.headers.get("retry-after");
    if (value === null || !/^\d+$/u.test(value)) {
        return DEFAULT_RETRY_AFTER_MILLISECONDS;
    }
    return Math.min(60_000, Math.max(100, Number(value) * 1_000));
}

async function recordingEpoch(response: Response): Promise<string | null> {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return null;
    }
    const value = Reflect.get(body, "recordingEpoch");
    return typeof value === "string" && isIdentifier(value) ? value : null;
}

export class PlatformSessionRecording implements SessionRecording {
    readonly #policies: RecordingPolicyStorage;
    readonly #provider: RecordingProvider;

    constructor(policies: RecordingPolicyStorage, provider: RecordingProvider) {
        if (provider.kind === "available" && !isIdentifier(provider.providerId)) {
            throw new Error("The Recording provider identifier is invalid");
        }
        this.#policies = policies;
        this.#provider = provider;
    }

    readonly deliver = async (
        target: SessionRecordingTarget,
        envelope: ReliableSessionEventEnvelope,
        signal: AbortSignal,
    ): Promise<SessionRecordingDeliveryResult> => {
        const policy = await this.#policies.readProject(target.projectId, signal);
        if (policy === null) {
            return { code: SessionEventRejectionCode.InvalidEvent, kind: "rejected" };
        }
        if (policy.effectiveMode === "disabled") {
            return { kind: "relayed" };
        }
        if (this.#provider.kind === "absent") {
            return { kind: "deferred", retryAfterMilliseconds: 5_000 };
        }

        const timeout = AbortSignal.timeout(RECORDING_REQUEST_TIMEOUT_MILLISECONDS);
        const requestSignal = AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
            response = await this.#provider.fetcher.fetch(
                new Request("https://recording.internal/v1/session-events", {
                    body: encodeSessionRecordingWrite({
                        envelope,
                        projectId: target.projectId,
                        runtimeId: target.runtimeId,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: requestSignal,
                }),
            );
        } catch {
            signal.throwIfAborted();
            if (timeout.aborted) {
                return { kind: "deferred", retryAfterMilliseconds: DEFAULT_RETRY_AFTER_MILLISECONDS };
            }
            return { kind: "deferred", retryAfterMilliseconds: DEFAULT_RETRY_AFTER_MILLISECONDS };
        }
        signal.throwIfAborted();
        if (response.status === 200 || response.status === 201) {
            const epoch = await recordingEpoch(response);
            if (epoch === null) {
                return { code: SessionEventRejectionCode.RecordingRejected, kind: "rejected" };
            }
            return {
                kind: "recorded",
                providerId: this.#provider.providerId,
                recordingEpoch: epoch,
            };
        }
        if (response.status === 429 || response.status >= 500) {
            return { kind: "deferred", retryAfterMilliseconds: retryAfter(response) };
        }
        return {
            code:
                response.status === 409
                    ? SessionEventRejectionCode.IdempotencyConflict
                    : SessionEventRejectionCode.RecordingRejected,
            kind: "rejected",
        };
    };
}

export function platformRecordingProvider(environment: {
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
}): RecordingProvider {
    return environment.RECORDING === undefined || environment.RECORDING_PROVIDER_ID === undefined
        ? { kind: "absent" }
        : {
              fetcher: environment.RECORDING,
              kind: "available",
              providerId: environment.RECORDING_PROVIDER_ID,
          };
}
