import { env } from "cloudflare:workers";
import { decodeSessionEventEnvelope, SESSION_EVENT_COMMITTED_KIND } from "@moxt-ai/mobius-protocol";
import { createDurableObjectContext, RuntimeRelay, type SessionTransport } from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "../src/database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "../src/project-storage-directory.ts";
import { STANDALONE_NAMESPACE_PREFIX } from "../src/standalone-namespace.ts";

// Real Session DO requests cannot be made to stall deterministically. This stateful transport lets the first
// disconnect complete, then suspends every later one until cancellation or release. It claims the suspension
// before forwarding, so which Session completes and which suspends stays deterministic.
export class SuspendedDisconnectTransport implements SessionTransport {
    readonly #transport: SessionTransport = {
        fetch: ({ scope, sessionId }, request) =>
            env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${scope.projectId}:${sessionId}`),
            ).fetch(request),
    };
    readonly #suspended = Promise.withResolvers<string>();
    readonly #released = Promise.withResolvers<void>();
    #state:
        | { readonly kind: "ready" }
        | { readonly kind: "suspending"; readonly completedSessionId: string }
        | { readonly kind: "released" } = {
        kind: "ready",
    };

    readonly suspended = this.#suspended.promise;
    readonly resume = (): void => {
        this.#state = { kind: "released" };
        this.#released.resolve();
    };

    readonly fetch: SessionTransport["fetch"] = async (target, request) => {
        const { sessionId } = target;
        if (!new URL(request.url).pathname.endsWith("/disconnect")) {
            return await this.#transport.fetch(target, request);
        }
        if (this.#state.kind === "ready") {
            // Claim the one completed disconnect synchronously, before awaiting: concurrent settles would
            // otherwise all observe "ready" and none would suspend.
            this.#state = { kind: "suspending", completedSessionId: sessionId };
            try {
                const response = await this.#transport.fetch(target, request);
                if (!response.ok) {
                    this.#state = { kind: "ready" };
                }
                return response;
            } catch (error) {
                this.#state = { kind: "ready" };
                throw error;
            }
        }
        if (this.#state.kind === "released") {
            return await this.#transport.fetch(target, request);
        }
        request.signal.throwIfAborted();
        const aborted = Promise.withResolvers<never>();
        const cancel = () => aborted.reject(request.signal.reason);
        request.signal.addEventListener("abort", cancel, { once: true });
        this.#suspended.resolve(this.#state.completedSessionId);
        try {
            await Promise.race([aborted.promise, this.#released.promise]);
            return await this.#transport.fetch(target, request);
        } finally {
            request.signal.removeEventListener("abort", cancel);
        }
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a record");
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = item;
    }
    return result;
}

// The Session transport is a production boundary. A real nested Durable Object
// request cannot be held across Miniflare execution contexts, so this stateful
// implementation emits a valid commit result after an explicit release.
export class SuspendedEventCommitTransport implements SessionTransport {
    readonly #committed = Promise.withResolvers<string>();
    readonly #observedSessionId: string;
    readonly #released = Promise.withResolvers<void>();
    readonly #sequences = new Map<string, number>();
    readonly #sessionId: string;
    readonly #summaries: ReadonlyMap<string, string>;
    readonly #suspended = Promise.withResolvers<void>();
    #held = false;

    constructor(sessionId: string, observedSessionId: string, summaries: ReadonlyMap<string, string>) {
        this.#sessionId = sessionId;
        this.#observedSessionId = observedSessionId;
        this.#summaries = summaries;
    }

    readonly committed = this.#committed.promise;
    readonly suspended = this.#suspended.promise;

    readonly resume = (): void => {
        this.#released.resolve();
    };

    readonly fetch: SessionTransport["fetch"] = async ({ sessionId }, request) => {
        if (!new URL(request.url).pathname.endsWith("/commit")) {
            throw new Error("Expected a Session commit request");
        }
        const requestBody = record(JSON.parse(await request.text()));
        const encodedEnvelope = requestBody["envelope"];
        if (typeof encodedEnvelope !== "string") {
            throw new Error("Expected an encoded Session event envelope");
        }
        const envelope = decodeSessionEventEnvelope(encodedEnvelope);
        if (envelope.sessionId !== sessionId) {
            throw new Error("Expected the Session transport target to match the envelope");
        }
        if (!this.#held && sessionId === this.#sessionId) {
            this.#held = true;
            request.signal.throwIfAborted();
            const aborted = Promise.withResolvers<never>();
            const cancel = () => aborted.reject(request.signal.reason);
            request.signal.addEventListener("abort", cancel, { once: true });
            this.#suspended.resolve();
            try {
                await Promise.race([aborted.promise, this.#released.promise]);
            } finally {
                request.signal.removeEventListener("abort", cancel);
            }
        }
        request.signal.throwIfAborted();
        const summary = this.#summaries.get(sessionId);
        if (summary === undefined) {
            throw new Error("Expected a Session summary for the transport target");
        }
        const sequence = this.#sequences.get(sessionId) ?? 0;
        this.#sequences.set(sessionId, sequence + 1);
        if (sessionId === this.#observedSessionId) {
            this.#committed.resolve(sessionId);
        }
        return new Response(
            JSON.stringify({
                committed: {
                    cursor: `fairness-${sessionId}-${sequence.toString()}`,
                    eventId: envelope.eventId,
                    kind: SESSION_EVENT_COMMITTED_KIND,
                    payload: envelope.payload,
                    recordedAt: "2026-09-11T00:00:00.000Z",
                    sequence: sequence.toString(),
                    sessionId,
                    source: envelope.source,
                },
                duplicate: false,
                summary: {
                    ...record(JSON.parse(summary)),
                    lastCommittedSeq: sequence.toString(),
                    updatedAt: "2026-09-11T00:00:00.000Z",
                },
            }),
            { headers: { "content-type": "application/json" } },
        );
    };
}

// Session storage can become temporarily unavailable independently from the Runtime
// channel. This fake exercises that production transport boundary without replacing
// the Runtime actor or its WebSocket handling.
export class UnavailableEventCommitTransport implements SessionTransport {
    readonly #sessionId: string;
    readonly #transport: SessionTransport = {
        fetch: ({ scope, sessionId }, request) =>
            env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${scope.projectId}:${sessionId}`),
            ).fetch(request),
    };

    constructor(sessionId: string) {
        this.#sessionId = sessionId;
    }

    readonly fetch: SessionTransport["fetch"] = async (target, request) => {
        const { sessionId } = target;
        if (sessionId === this.#sessionId && new URL(request.url).pathname.endsWith("/commit")) {
            throw new Error("The Session Durable Object is unavailable");
        }
        return await this.#transport.fetch(target, request);
    };
}

export function runtimeWithTransport(state: DurableObjectState, sessionTransport: SessionTransport): RuntimeRelay {
    return new RuntimeRelay(
        createDurableObjectContext(state, {
            environment: env,
            sessions: env.SESSION_RELAY,
            namespacePrefix: STANDALONE_NAMESPACE_PREFIX,
            databases: new SingleDatabaseResolver(env.DIRECTORY_DATABASE),
            projects: new StandaloneProjectStorageDirectory(),
            content: { kind: "sqlite" },
            sessionTransport,
        }),
    );
}

// A Project must not serialize its Runtime attach behind one Session round trip per Session. This records
// the greatest number of pending-delivery probes the production Runtime kept in flight at once, so the
// fan-out bound stays observable through the same production Session port the Relay uses in deployment.
export class RecordingDeliveryProbeTransport implements SessionTransport {
    readonly #transport: SessionTransport = {
        fetch: ({ scope, sessionId }, request) =>
            env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${scope.projectId}:${sessionId}`),
            ).fetch(request),
    };
    #inFlight = 0;
    #maximum = 0;

    readonly maximumConcurrentProbes = (): number => this.#maximum;

    readonly fetch: SessionTransport["fetch"] = async (target, request) => {
        if (!new URL(request.url).pathname.endsWith("/pending-daemon-deliveries")) {
            return await this.#transport.fetch(target, request);
        }
        this.#inFlight += 1;
        this.#maximum = Math.max(this.#maximum, this.#inFlight);
        try {
            return await this.#transport.fetch(target, request);
        } finally {
            this.#inFlight -= 1;
        }
    };
}

// Settling a Runtime disconnect must reach only the Sessions the Runtime still had work for. This records the
// Sessions a disconnect visited, so "a finished Session is never revisited" stays observable through the same
// production Session port the Relay uses in deployment.
export class RecordingDisconnectTransport implements SessionTransport {
    readonly #transport: SessionTransport = {
        fetch: ({ scope, sessionId }, request) =>
            env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${STANDALONE_NAMESPACE_PREFIX}:${scope.projectId}:${sessionId}`),
            ).fetch(request),
    };
    readonly #disconnected = new Set<string>();

    readonly disconnectedSessions = (): readonly string[] => [...this.#disconnected].sort();

    readonly fetch: SessionTransport["fetch"] = async (target, request) => {
        if (new URL(request.url).pathname.endsWith("/disconnect")) {
            this.#disconnected.add(target.sessionId);
        }
        return await this.#transport.fetch(target, request);
    };
}
