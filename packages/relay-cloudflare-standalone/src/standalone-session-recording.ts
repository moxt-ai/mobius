import { encodeSessionRecordingWrite, isIdentifier, SessionEventRejectionCode } from "@moxt-ai/mobius-protocol";
import type {
    SessionRecording,
    SessionRecordingDeliveryResult,
    SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import type { StandaloneRecordingConfigurationStorage } from "./storage/standalone-recording-configuration-storage.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_RETRY_AFTER_MILLISECONDS = 1_000;

export type StandaloneRecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

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

export function standaloneRecordingProvider(environment: {
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
}): StandaloneRecordingProvider {
    return environment.RECORDING === undefined || environment.RECORDING_PROVIDER_ID === undefined
        ? { kind: "absent" }
        : { fetcher: environment.RECORDING, kind: "available", providerId: environment.RECORDING_PROVIDER_ID };
}

export class StandaloneSessionRecording implements SessionRecording {
    readonly #configuration: StandaloneRecordingConfigurationStorage;
    readonly #provider: StandaloneRecordingProvider;

    constructor(configuration: StandaloneRecordingConfigurationStorage, provider: StandaloneRecordingProvider) {
        this.#configuration = configuration;
        this.#provider = provider;
    }

    readonly deliver = async (
        target: SessionRecordingTarget,
        envelope: Parameters<SessionRecording["deliver"]>[1],
        signal: AbortSignal,
    ): Promise<SessionRecordingDeliveryResult> => {
        const configuration = await this.#configuration.read(target.projectId, signal);
        if (configuration.state === "unconfigured" || !configuration.enabled) {
            return { kind: "relayed" };
        }
        if (this.#provider.kind === "absent") {
            return { kind: "deferred", retryAfterMilliseconds: 5_000 };
        }
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
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
                    signal: AbortSignal.any([signal, timeout]),
                }),
            );
        } catch {
            signal.throwIfAborted();
            return { kind: "deferred", retryAfterMilliseconds: DEFAULT_RETRY_AFTER_MILLISECONDS };
        }
        signal.throwIfAborted();
        if (response.status === 200 || response.status === 201) {
            const epoch = await recordingEpoch(response);
            return epoch === null
                ? { code: SessionEventRejectionCode.RecordingRejected, kind: "rejected" }
                : { kind: "recorded", providerId: this.#provider.providerId, recordingEpoch: epoch };
        }
        if (response.status === 429 || response.status >= 500) {
            return { kind: "deferred", retryAfterMilliseconds: DEFAULT_RETRY_AFTER_MILLISECONDS };
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
