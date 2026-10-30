import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay, type SessionRecording } from "@moxt-ai/mobius-relay-core";
import { decodeSessionRecordingWireWrite, type SessionWireEvent } from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
import { PlatformSessionRecording } from "../src/gateway/platform-session-recording.ts";
import { platformProjectRecordingPolicy } from "../src/schema/d1/index.ts";
import { platformDrizzle } from "../src/storage/platform-drizzle-database.ts";
import { RecordingPolicyStorage } from "../src/storage/recording-policy-storage.ts";
import { registerRuntimeFixture } from "./registered-runtime.ts";

// Longer than a delivery's deadline followed by every retry wait.
const SETTLE_LIMIT_MILLISECONDS = 30_000;

beforeEach(() => {
    // Delivery deadlines and retry waits run on the test's clock.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

type ScriptedOutcome = "recorded" | "unanswered" | "write_failed";

/** A Recording that answers each delivery with the next scripted outcome, then records; it keeps every delivery. */
class ScriptedRecording implements SessionRecording {
    readonly deliveries: (readonly SessionWireEvent[])[] = [];
    readonly #outcomes: ScriptedOutcome[];

    constructor(outcomes: readonly ScriptedOutcome[]) {
        this.#outcomes = [...outcomes];
    }

    readonly deliverBatch: SessionRecording["deliverBatch"] = async (_target, envelope, signal) => {
        signal.throwIfAborted();
        this.deliveries.push(envelope.events);
        const outcome = this.#outcomes.shift() ?? "recorded";
        if (outcome === "unanswered") {
            // Only the Relay's delivery deadline ends the wait.
            return await new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        }
        return [...new Set(envelope.events.map((event) => event.sessionId))].map((sessionId) =>
            outcome === "recorded"
                ? { sessionId, kind: "recorded" as const }
                : { sessionId, kind: "failed" as const, code: outcome },
        );
    };
}

/** The Recording service, answering each write with the next scripted status and keeping every write it receives. */
class ScriptedRecordingService {
    readonly writes: (readonly SessionWireEvent[])[] = [];
    readonly #statuses: number[];

    constructor(statuses: readonly number[]) {
        this.#statuses = [...statuses];
    }

    readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const write = decodeSessionRecordingWireWrite(await new Request(input, init).text());
        this.writes.push(write.envelope.events);
        const status = this.#statuses.shift() ?? 201;
        if (status !== 201) {
            return Response.json({ error: { code: "scripted_failure" } }, { status });
        }
        const sessions = [...new Set(write.envelope.events.map((event) => event.sessionId))];
        return Response.json({ results: sessions.map((sessionId) => ({ sessionId, kind: "recorded" })) }, { status });
    };

    readonly connect = (): Socket => {
        throw new Error("The Recording service accepts only HTTP requests");
    };
}

interface RecordingRelay {
    /** Hands a daemon's Session event batch to the Relay's WebSocket handler. */
    readonly send: (events: readonly SessionWireEvent[]) => Promise<void>;
    /**
     * Waits until every Recording delivery the Relay started, and any delivery or retry it starts in turn, is done.
     * Meanwhile the test's clock runs in short steps, so a retry wait passes soon after the attempt before it, and a
     * delivery's deadline passes only when Recording does not answer.
     */
    readonly settle: () => Promise<void>;
}

async function withRecordingRelay(
    recordingFor: (projectId: string) => Promise<SessionRecording>,
    scenario: (relay: RecordingRelay) => Promise<void>,
): Promise<void> {
    const runtimeId = `recording-retry-${crypto.randomUUID()}`;
    const projectId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerRuntimeFixture(projectId, runtimeId);
    const recording = await recordingFor(projectId);
    await runInDurableObject(env.RUNTIME_RELAY.getByName(runtimeId), async (_instance, state) => {
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, env, { database });
        const pending: Promise<void>[] = [];
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: context.storages,
                gateways: {
                    peers: context.gateways.peers,
                    projectCredentials: context.gateways.projectCredentials,
                    recording,
                },
                utilities: { waitUntil: (operation) => pending.push(operation) },
            }),
        );
        const response = await relay.fetch(
            new Request(`https://runtime.internal/projects/${projectId}/daemon`, {
                headers: { Upgrade: "websocket", "x-mobius-channel-id": runtimeId, "x-mobius-runtime-id": runtimeId },
            }),
        );
        expect(response.status).toBe(101);
        const client = response.webSocket;
        const [daemon] = state.getWebSockets("daemon");
        if (client === null || daemon === undefined) {
            throw new Error("Expected a connected daemon");
        }
        client.accept();
        const settle = async (): Promise<void> => {
            let done = false;
            const drained = (async () => {
                while (pending.length > 0) {
                    await Promise.allSettled(pending.splice(0));
                }
                done = true;
            })();
            for (let elapsed = 0; !done && elapsed < SETTLE_LIMIT_MILLISECONDS; elapsed += 100) {
                await vi.advanceTimersByTimeAsync(100);
            }
            await drained;
        };
        try {
            await scenario({
                send: async (events) =>
                    await relay.webSocketMessage(daemon, JSON.stringify({ kind: "session.event.v2", events })),
                settle,
            });
        } finally {
            client.close(1000, "Test complete");
        }
    });
}

/** The Platform's Recording gateway in front of a scripted Recording service, for a Project that records. */
function platformRecording(service: ScriptedRecordingService): (projectId: string) => Promise<SessionRecording> {
    return async (projectId) => {
        await platformDrizzle(env.PLATFORM_DIRECTORY_DATABASE)
            .insert(platformProjectRecordingPolicy)
            .values({ projectId, mode: "enabled", updatedAt: Date.now() });
        return new PlatformSessionRecording(new RecordingPolicyStorage(env.PLATFORM_DIRECTORY_DATABASE), {
            fetcher: service,
            kind: "available",
            providerId: "recording-retry",
        });
    };
}

/** A fixed Recording for scenarios that script its answers directly. */
const scripted =
    (recording: ScriptedRecording): (() => Promise<SessionRecording>) =>
    async () =>
        recording;

function event(position: number): SessionWireEvent {
    return {
        eventId: `event-${position}`,
        position: String(position),
        recordedAt: "2026-10-30T00:00:00.000Z",
        sessionGenerationId: "generation-1",
        sessionId: "session-1",
        type: "acp",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Chunk ${position}` } },
    } as SessionWireEvent;
}

const omitted = (recorded: SessionWireEvent): SessionWireEvent =>
    ({ ...recorded, mobiusMetadata: { omitted: true } }) as SessionWireEvent;

it("Given Recording fails a Session's write once, When the Relay retries after a backoff, Then Recording receives those events again before later ones and none is marked omitted", async () => {
    const recording = new ScriptedRecording(["write_failed"]);
    await withRecordingRelay(scripted(recording), async ({ send, settle }) => {
        await send([event(1), event(2)]);
        await send([event(3)]);
        await settle();

        expect(recording.deliveries).toEqual([[event(1), event(2)], [event(1), event(2)], [event(3)]]);
    });
});

it("Given Recording does not answer a Session's write before the deadline, When the Relay retries, Then Recording receives those events again", async () => {
    const recording = new ScriptedRecording(["unanswered"]);
    await withRecordingRelay(scripted(recording), async ({ send, settle }) => {
        await send([event(1)]);
        await settle();

        expect(recording.deliveries).toEqual([[event(1)], [event(1)]]);
    });
});

it("Given Recording keeps failing a Session's write, When the retries run out, Then the Relay has waited between them, drops those events and marks the next recorded event omitted", async () => {
    const recording = new ScriptedRecording(["write_failed", "write_failed", "write_failed", "write_failed"]);
    await withRecordingRelay(scripted(recording), async ({ send, settle }) => {
        const startedAt = Date.now();
        await send([event(1)]);
        await settle();
        const retriedFor = Date.now() - startedAt;
        await send([event(2)]);
        await settle();

        expect(recording.deliveries).toEqual([[event(1)], [event(1)], [event(1)], [event(1)], [omitted(event(2))]]);
        expect(retriedFor).toBeGreaterThanOrEqual(1_000 + 2_000 + 4_000);
    });
});

it("Given a Session's retries ran out, When its next write fails as well, Then the Relay drops it at once and retries again after a write is recorded", async () => {
    const recording = new ScriptedRecording([
        ...Array<ScriptedOutcome>(5).fill("write_failed"),
        "recorded",
        "write_failed",
    ]);
    await withRecordingRelay(scripted(recording), async ({ send, settle }) => {
        for (const position of [1, 2, 3, 4]) {
            await send([event(position)]);
            await settle();
        }

        expect(recording.deliveries).toEqual([
            [event(1)],
            [event(1)],
            [event(1)],
            [event(1)],
            [omitted(event(2))],
            [omitted(event(3))],
            [event(4)],
            [event(4)],
        ]);
    });
});

it("Given the Recording service answers a server error and then throttles, When the Relay retries, Then its third write is recorded", async () => {
    const service = new ScriptedRecordingService([503, 429]);
    await withRecordingRelay(platformRecording(service), async ({ send, settle }) => {
        await send([event(1)]);
        await settle();
        await send([event(2)]);
        await settle();

        expect(service.writes).toEqual([[event(1)], [event(1)], [event(1)], [event(2)]]);
    });
});

it("Given the Recording service rejects a Session's write, When the Relay hears the rejection, Then it does not retry and marks the next recorded event omitted", async () => {
    const service = new ScriptedRecordingService([400]);
    await withRecordingRelay(platformRecording(service), async ({ send, settle }) => {
        await send([event(1)]);
        await settle();
        await send([event(2)]);
        await settle();

        expect(service.writes).toEqual([[event(1)], [omitted(event(2))]]);
    });
});
