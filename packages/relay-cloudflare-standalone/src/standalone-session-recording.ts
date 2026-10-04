import { encodeSessionRecordingWrite } from "@moxt-ai/mobius-protocol";
import type {
    SessionRecording,
    SessionRecordingDeliveryResult,
    SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import type { StandaloneRecordingConfigurationStorage } from "./storage/standalone-recording-configuration-storage.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

export type StandaloneRecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

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
            return { kind: "skipped" };
        }
        if (this.#provider.kind === "absent") {
            return { kind: "failed", code: "provider_unavailable" };
        }
        try {
            const response = await this.#provider.fetcher.fetch(
                new Request("https://recording.internal/v1/session-events", {
                    body: encodeSessionRecordingWrite({
                        envelope,
                        projectId: target.projectId,
                        runtimeId: target.runtimeId,
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]),
                }),
            );
            signal.throwIfAborted();
            await response.body?.cancel();
            return response.ok ? { kind: "recorded" } : { kind: "failed", code: "write_failed" };
        } catch {
            signal.throwIfAborted();
            return { kind: "failed", code: "write_failed" };
        }
    };
}
