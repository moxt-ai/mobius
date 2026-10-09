import { encodeSessionRecordingWrite, isIdentifier, type SessionEventEnvelopeV2 } from "@moxt-ai/mobius-protocol";
import type {
    SessionRecording,
    SessionRecordingDeliveryResult,
    SessionRecordingTarget,
} from "@moxt-ai/mobius-relay-core";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

const RECORDING_REQUEST_TIMEOUT_MILLISECONDS = 10_000;

export type RecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

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
        envelope: SessionEventEnvelopeV2,
        signal: AbortSignal,
    ): Promise<SessionRecordingDeliveryResult> => {
        const policy = await this.#policies.readProject(target.projectId, signal);
        if (policy === null) {
            return { kind: "failed", code: "policy_unavailable" };
        }
        if (policy.effectiveMode === "disabled") {
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
                    signal: AbortSignal.any([signal, AbortSignal.timeout(RECORDING_REQUEST_TIMEOUT_MILLISECONDS)]),
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
