#!/usr/bin/env node
/**
 * Measures Session event acknowledgement latency through a deployed Mobius Relay.
 *
 * It creates an isolated Project, chooses Recording, pairs one Runtime, streams reliable Session events the
 * same way the production daemon does, and reports latency percentiles plus the Runtime's server-side
 * Recording metrics when the deployment exposes them. Nothing here is production code: it is a repeatable
 * capacity measurement tool, so it uses only `fetch` and `WebSocket`.
 *
 * `fetch` and `WebSocket` come from `undici` because the daemon's Relay handshake authenticates with an
 * `Authorization` header, which the platform WebSocket API cannot send.
 *
 * Usage:
 *   node scripts/measure-recording-latency.ts --origin https://mobius-standalone.moxt.ai \
 *     --sessions 8 --turns 2 --deltas 50 --window 4
 *   node scripts/measure-recording-latency.ts --origin https://mobius-standalone.moxt.ai --no-recording
 */
import { fetch, WebSocket } from "undici";

const SESSION_EVENT_KIND = "session.event";
const ACK_TIMEOUT_MILLISECONDS = 60_000;

interface Options {
    readonly deltas: number;
    readonly origin: string;
    readonly pollMetrics: boolean;
    readonly recording: boolean;
    readonly sessions: number;
    readonly textLength: number;
    readonly turns: number;
    readonly window: number;
}

function readNumber(arguments_: readonly string[], name: string, fallback: number): number {
    const index = arguments_.indexOf(`--${name}`);
    const value = index < 0 ? undefined : arguments_[index + 1];
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`--${name} requires a positive integer`);
    }
    return parsed;
}

function readOptions(arguments_: readonly string[]): Options {
    const index = arguments_.indexOf("--origin");
    const origin = index < 0 ? undefined : arguments_[index + 1];
    if (origin === undefined) {
        throw new Error("--origin <relay-origin> is required");
    }
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("--origin must be an http or https origin");
    }
    return {
        deltas: readNumber(arguments_, "deltas", 50),
        origin: parsed.origin,
        pollMetrics: arguments_.includes("--poll-metrics"),
        recording: !arguments_.includes("--no-recording"),
        sessions: readNumber(arguments_, "sessions", 1),
        textLength: readNumber(arguments_, "text-length", 400),
        turns: readNumber(arguments_, "turns", 2),
        window: readNumber(arguments_, "window", 1),
    };
}

const CAPABILITIES = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: false,
    resumeSession: true,
    steering: false,
    unstableForkSession: false,
} as const;

/** Undici's `Response` differs structurally from the platform type, so the shape actually read is named here. */
interface FetchResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly text: () => Promise<string>;
}

async function json(response: FetchResponse): Promise<Record<string, unknown>> {
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Relay returned ${response.status.toString()}: ${body.slice(0, 300)}`);
    }
    return JSON.parse(body) as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`The Relay returned an invalid ${field}`);
    }
    return value;
}

async function percentile(samples: readonly number[], fraction: number): Promise<number> {
    const sorted = [...samples].sort((left, right) => left - right);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return round(sorted[rank] ?? 0);
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

const METRICS_POLL_MILLISECONDS = 50;

/**
 * Samples the Runtime's server-side Recording metrics while the stream runs. The snapshot read after the
 * stream idles always reports an empty queue, so peak depth is only visible from concurrent sampling.
 */
function pollRecordingMetrics(
    url: string,
    credential: string,
): {
    readonly stop: () => Promise<Record<string, unknown> | null>;
} {
    let active = true;
    let latest: Record<string, unknown> | null = null;
    const peak = new Map<string, number>();
    const loop = async (): Promise<void> => {
        while (active) {
            try {
                const response = await fetch(url, {
                    headers: { authorization: `Bearer ${credential}` },
                    signal: AbortSignal.timeout(10_000),
                });
                if (response.ok) {
                    latest = (await response.json()) as Record<string, unknown>;
                    const scheduler = latest?.["scheduler"];
                    if (typeof scheduler === "object" && scheduler !== null) {
                        for (const [name, value] of Object.entries(scheduler as Record<string, number>)) {
                            if (typeof value === "number" && (peak.get(name) ?? 0) < value) {
                                peak.set(name, value);
                            }
                        }
                    }
                }
            } catch {
                // A failed sample is not a measurement failure; the final snapshot still reports the totals.
            }
            await new Promise<void>((resolve) => {
                setTimeout(resolve, METRICS_POLL_MILLISECONDS).unref();
            });
        }
    };
    void loop();
    return {
        stop: async () => {
            active = false;
            return latest === null ? null : { ...latest, scheduler: Object.fromEntries(peak) };
        },
    };
}

interface Measurement extends Readonly<Record<string, unknown>> {
    readonly eventsPerSecond: number;
    readonly samples: readonly number[];
}

/** One isolated Project, paired Runtime, and daemon-equivalent Session event stream. */
async function measureOneRuntime(options: Options, index: number): Promise<Measurement> {
    const api = `${options.origin}/mobius/api`;
    const created = await json(
        await fetch(`${api}/v1/standalone/projects`, { method: "POST", signal: AbortSignal.timeout(30_000) }),
    );
    const projectId = string(created["projectId"], "projectId");
    const projectToken = string(created["token"], "token");
    await fetch(`${api}/v1/projects/${projectId}/recording`, {
        body: JSON.stringify({ enabled: options.recording }),
        headers: { authorization: `Bearer ${projectToken}`, "content-type": "application/json" },
        method: "PUT",
        signal: AbortSignal.timeout(30_000),
    });
    const pairing = await json(
        await fetch(`${api}/v1/projects/${projectId}/runtime-pairings`, {
            body: JSON.stringify({ idempotencyKey: `measure-${index.toString()}-${Date.now().toString()}` }),
            headers: { authorization: `Bearer ${projectToken}`, "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(30_000),
        }),
    );
    const runtimeId = string(pairing["runtimeId"], "runtimeId");
    const redeemed = await json(
        await fetch(`${api}/v1/runtime-pairings/${string(pairing["pairingId"], "pairingId")}/redeem`, {
            body: JSON.stringify({
                agents: [
                    {
                        agentPath: "/usr/local/bin/codex",
                        agentSettingsDiscovery: true,
                        agentVersion: "measure-recording-latency",
                        capabilities: CAPABILITIES,
                        id: "codex",
                        label: "Codex",
                        sessionTurnConfiguration: true,
                    },
                ],
                installableAgents: [],
                machineName: `measure-${index.toString()}`,
                pairingCode: string(pairing["pairingCode"], "pairingCode"),
                workspaceName: "measure",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(30_000),
        }),
    );

    const connect = new URL(`${api}/v1/runtimes/connect`);
    connect.protocol = connect.protocol === "https:" ? "wss:" : "ws:";
    connect.searchParams.set("liveness", "1");
    connect.searchParams.set("sessionEventDelivery", "reliable-v1");
    const socket = new WebSocket(connect, {
        headers: { authorization: `Bearer ${string(redeemed["runtimeCredential"], "runtimeCredential")}` },
    });
    try {
        const samples: number[] = [];
        const lifecycle: number[] = [];
        const pending = new Map<
            string,
            { readonly at: number; readonly lifecycle: boolean; readonly resolve: () => void }
        >();
        let deferred = 0;
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message["kind"] === "runtime.heartbeat") {
                socket.send(JSON.stringify({ heartbeatId: message["heartbeatId"], kind: "runtime.heartbeat.ack" }));
                return;
            }
            if (message["kind"] === "session.event.ack") {
                const entry = pending.get(string(message["eventId"], "eventId"));
                pending.delete(string(message["eventId"], "eventId"));
                if (entry !== undefined) {
                    const durationMilliseconds = performance.now() - entry.at;
                    samples.push(durationMilliseconds);
                    if (entry.lifecycle) {
                        lifecycle.push(durationMilliseconds);
                    }
                    entry.resolve();
                }
                return;
            }
            if (message["kind"] === "session.event.deferred") {
                deferred += 1;
            }
        });
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener("error", () => reject(new Error("The Relay connection failed")), { once: true });
        });
        await new Promise<void>((resolve) =>
            socket.addEventListener(
                "message",
                (event) => {
                    if (
                        (JSON.parse(String(event.data)) as { readonly kind?: string }).kind === "runtime.liveness.ready"
                    ) {
                        resolve();
                    }
                },
                { once: true },
            ),
        );

        const streamId = `measure-${index.toString()}-${Date.now().toString()}`;
        const text = "m".repeat(options.textLength);
        let sequence = 0;
        const drains: Promise<void>[] = [];
        const send = (kind: string, body: Record<string, unknown>, sessionId: string): Promise<void> => {
            sequence += 1;
            const eventId = `${streamId}-${sequence.toString()}`;
            const startedAt = performance.now();
            const completion = new Promise<void>((resolve) =>
                pending.set(eventId, {
                    at: startedAt,
                    lifecycle: kind !== "agent.message.delta",
                    resolve,
                }),
            );
            socket.send(
                JSON.stringify({
                    delivery: { eventId, kind: "reliable", sourceSeq: sequence.toString(), streamId },
                    kind: SESSION_EVENT_KIND,
                    payload: JSON.stringify({ ...body, kind, sessionId }),
                    sessionId,
                }),
            );
            drains.push(completion);
            // The production daemon bounds unacknowledged events; drain the oldest one to keep that bound.
            if (drains.length > options.window) {
                const oldest = drains.shift();
                return oldest === undefined ? Promise.resolve() : oldest;
            }
            return Promise.resolve();
        };

        const startedAt = Date.now();
        const polling = options.pollMetrics
            ? pollRecordingMetrics(
                  `${api}/v1/projects/${projectId}/runtimes/${runtimeId}/recording-metrics`,
                  projectToken,
              )
            : null;
        for (let turn = 1; turn <= options.turns; turn += 1) {
            const sessionId = `measure-session-${index.toString()}-${turn.toString()}`;
            const commandId = `measure-command-${index.toString()}-${turn.toString()}`;
            await send(
                "session.ready",
                {
                    additionalDirectories: [],
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "measure-recording-latency",
                    capabilities: CAPABILITIES,
                    commands: [],
                    configOptions: [],
                    directoryId: "default",
                    directoryLabel: "Workspace",
                    requestId: `measure-request-${index.toString()}-${turn.toString()}`,
                    restored: false,
                },
                sessionId,
            );
            await send(
                "session.started",
                { attemptId: commandId, commandId, epoch: commandId, prompt: "measure", sequence: 0 },
                sessionId,
            );
            for (let delta = 1; delta <= options.deltas; delta += 1) {
                await send(
                    "agent.message.delta",
                    {
                        commandId,
                        epoch: commandId,
                        messageId: `measure-message-${turn.toString()}`,
                        sequence: delta,
                        text,
                    },
                    sessionId,
                );
            }
            await send("session.completed", { commandId, stopReason: "end_turn" }, sessionId);
        }
        // A Relay that stops acknowledging must fail the measurement instead of hanging it.
        let expire: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                Promise.all(drains.splice(0)),
                new Promise<never>((_resolve, reject) => {
                    expire = setTimeout(
                        () => reject(new Error("Session event acknowledgements timed out")),
                        ACK_TIMEOUT_MILLISECONDS,
                    );
                }),
            ]);
        } finally {
            if (expire !== undefined) {
                clearTimeout(expire);
            }
        }
        const elapsedMilliseconds = Date.now() - startedAt;
        if (pending.size > 0) {
            throw new Error(`${pending.size.toString()} Session events were never acknowledged`);
        }

        const polled = (await polling?.stop()) ?? null;
        const metricsResponse = await fetch(`${api}/v1/projects/${projectId}/runtimes/${runtimeId}/recording-metrics`, {
            headers: { authorization: `Bearer ${projectToken}` },
            signal: AbortSignal.timeout(30_000),
        });
        const metrics =
            metricsResponse.status === 200
                ? await json(metricsResponse)
                : { unavailable: `recording-metrics returned ${metricsResponse.status.toString()}` };

        return {
            deferred,
            elapsedSeconds: round(elapsedMilliseconds / 1000),
            eventsPerSecond: round(samples.length / (elapsedMilliseconds / 1000)),
            samples,
            lifecycle: {
                count: lifecycle.length,
                max: round(Math.max(...lifecycle, 0)),
                p50: await percentile(lifecycle, 0.5),
                p95: await percentile(lifecycle, 0.95),
            },
            latencyMilliseconds: {
                count: samples.length,
                max: round(Math.max(...samples, 0)),
                p50: await percentile(samples, 0.5),
                p95: await percentile(samples, 0.95),
                p99: await percentile(samples, 0.99),
            },
            polledMetrics: polled,
            projectId,
            runtimeId,
            serverMetrics: metrics,
        };
    } finally {
        socket.close(1000, "Measurement complete");
    }
}

async function main(): Promise<void> {
    const options = readOptions(process.argv.slice(2));
    const startedAt = Date.now();
    const measurements = await Promise.all(
        Array.from({ length: options.sessions }, (_unused, index) => measureOneRuntime(options, index)),
    );
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const combined = measurements.flatMap((measurement) => measurement.samples);
    const rates = measurements.map((measurement) => measurement.eventsPerSecond);
    const results = measurements.map(({ samples: _samples, ...reported }) => reported);
    const peakScheduler = results
        .map((result) => (result["polledMetrics"] as Record<string, unknown> | null)?.["scheduler"])
        .filter((scheduler): scheduler is Record<string, number> => typeof scheduler === "object" && scheduler !== null)
        .reduce<Record<string, number>>((accumulator, scheduler) => {
            for (const [name, value] of Object.entries(scheduler)) {
                accumulator[name] = Math.max(accumulator[name] ?? 0, value);
            }
            return accumulator;
        }, {});
    console.log(
        JSON.stringify(
            {
                aggregateEventsPerSecond: round(rates.reduce((total, rate) => total + rate, 0)),
                combinedLatencyMilliseconds: {
                    count: combined.length,
                    max: round(Math.max(...combined, 0)),
                    p50: await percentile(combined, 0.5),
                    p95: await percentile(combined, 0.95),
                    p99: await percentile(combined, 0.99),
                },
                configuration: options,
                elapsedSeconds: round(elapsedSeconds),
                peakSchedulerDepth: peakScheduler,
                results,
                sessions: measurements.length,
            },
            null,
            1,
        ),
    );
}

await main();
// A closing Relay socket would otherwise keep this measurement process alive after it has reported.
process.exit(0);
