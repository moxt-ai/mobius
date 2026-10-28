import type { SessionRecording, SessionRecordingBatchResult, SessionRecordingScope } from "@moxt-ai/mobius-relay-core";
import { encodeSessionRecordingWireWrite, isIdentifier, type SessionWireEnvelope } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import type { ResolvedRecordingPolicy } from "../entity/recording-policy.ts";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";

const batchResponseSchema = v.object({
    results: v.pipe(
        v.array(
            v.variant("kind", [
                v.object({
                    sessionId: v.pipe(
                        v.string(),
                        v.check((value: string) => isIdentifier(value)),
                    ),
                    kind: v.literal("recorded"),
                }),
                v.object({
                    sessionId: v.pipe(
                        v.string(),
                        v.check((value: string) => isIdentifier(value)),
                    ),
                    kind: v.literal("failed"),
                    code: v.literal("write_failed"),
                }),
            ]),
        ),
        v.minLength(1),
        v.maxLength(256),
    ),
});

const RECORDING_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
// A Project's resolved policy is reused this long, so a streaming reply does not read D1 for every batch
// it records. A changed policy applies to the deliveries that start after the reuse ends.
const RECORDING_POLICY_REUSE_MILLISECONDS = 5_000;
export type RecordingProvider =
    | { readonly kind: "absent" }
    | { readonly fetcher: Fetcher; readonly kind: "available"; readonly providerId: string };

export class PlatformSessionRecording implements SessionRecording {
    readonly #policies: RecordingPolicyStorage;
    readonly #provider: RecordingProvider;
    readonly #reusablePolicies = new Map<
        string,
        { readonly policy: ResolvedRecordingPolicy; readonly readAt: number }
    >();

    constructor(policies: RecordingPolicyStorage, provider: RecordingProvider) {
        if (provider.kind === "available" && !isIdentifier(provider.providerId)) {
            throw new Error("The Recording provider identifier is invalid");
        }
        this.#policies = policies;
        this.#provider = provider;
    }

    readonly deliverBatch = async (
        target: SessionRecordingScope,
        envelope: SessionWireEnvelope,
        signal: AbortSignal,
    ): Promise<readonly SessionRecordingBatchResult[]> => {
        const sessions = [...new Set(envelope.events.map((event) => event.sessionId))];
        const failed = (
            code: "policy_unavailable" | "provider_unavailable" | "write_failed",
        ): readonly SessionRecordingBatchResult[] => sessions.map((sessionId) => ({ sessionId, kind: "failed", code }));
        const policy = await this.#projectPolicy(target.projectId, signal);
        if (policy === null) {
            return failed("policy_unavailable");
        }
        if (policy.effectiveMode === "disabled") {
            return sessions.map((sessionId) => ({ sessionId, kind: "skipped" }));
        }
        if (this.#provider.kind === "absent") {
            return failed("provider_unavailable");
        }
        try {
            const response = await this.#provider.fetcher.fetch(
                new Request("https://recording.internal/v1/session-event-batches", {
                    body: encodeSessionRecordingWireWrite({
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
            let results: readonly SessionRecordingBatchResult[];
            if (response.status === 404) {
                // An older Recording Worker has not appended anything at the missing batch route.
                // This compatibility path is safe during rolling deployment; uncertain writes are never retried.
                await response.body?.cancel();
                results = await this.#deliverLegacy(target, envelope, signal);
            } else {
                if (!response.ok) {
                    await response.body?.cancel();
                    return failed("write_failed");
                }
                results = v.parse(batchResponseSchema, await response.json()).results;
            }
            const decoded = { results };
            const identifiers = new Set(decoded.results.map((result) => result.sessionId));
            if (
                identifiers.size !== sessions.length ||
                decoded.results.length !== sessions.length ||
                sessions.some((id) => !identifiers.has(id))
            ) {
                return failed("write_failed");
            }
            return decoded.results;
        } catch {
            signal.throwIfAborted();
            return failed("write_failed");
        }
    };

    /** The Project's policy, reused while it was read recently; an unavailable read is never reused. */
    async #projectPolicy(projectId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy | null> {
        const now = Date.now();
        const reusable = this.#reusablePolicies.get(projectId);
        if (
            reusable !== undefined &&
            now >= reusable.readAt &&
            now - reusable.readAt < RECORDING_POLICY_REUSE_MILLISECONDS
        ) {
            return reusable.policy;
        }
        console.info(JSON.stringify({ event: "recording_policy_read" }));
        const policy = await this.#policies.readProject(projectId, signal);
        if (policy === null) {
            this.#reusablePolicies.delete(projectId);
        } else {
            this.#reusablePolicies.set(projectId, { policy, readAt: now });
        }
        return policy;
    }

    async #deliverLegacy(
        target: SessionRecordingScope,
        envelope: SessionWireEnvelope,
        signal: AbortSignal,
    ): Promise<readonly SessionRecordingBatchResult[]> {
        if (this.#provider.kind !== "available") {
            throw new Error("The Recording provider is unavailable");
        }
        const provider = this.#provider.fetcher;
        const grouped = new Map<string, SessionWireEnvelope["events"][number][]>();
        for (const event of envelope.events) {
            const events = grouped.get(event.sessionId) ?? [];
            events.push(event);
            grouped.set(event.sessionId, events);
        }
        const entries = [...grouped];
        const results = new Map<string, SessionRecordingBatchResult>();
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(4, entries.length) }, async () => {
                for (;;) {
                    const item = entries[next++];
                    if (item === undefined) {
                        return;
                    }
                    const [sessionId, events] = item;
                    let recorded = false;
                    try {
                        const response = await provider.fetch(
                            new Request("https://recording.internal/v1/session-events", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: encodeSessionRecordingWireWrite({
                                    ...target,
                                    envelope: { kind: envelope.kind, events },
                                }),
                                signal,
                            }),
                        );
                        recorded = response.ok;
                        await response.body?.cancel();
                    } catch {
                        signal.throwIfAborted();
                    }
                    results.set(
                        sessionId,
                        recorded
                            ? { sessionId, kind: "recorded" }
                            : { sessionId, kind: "failed", code: "write_failed" },
                    );
                }
            }),
        );
        return entries.map(
            ([sessionId]) => results.get(sessionId) ?? { sessionId, kind: "failed", code: "write_failed" },
        );
    }
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
