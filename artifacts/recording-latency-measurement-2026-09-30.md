# Recording latency and throughput measurement — 2026-09-30

## What is now measurable

The Relay reports, per Runtime and per Project credential:

```sh
GET /mobius/api/v1/projects/{projectId}/runtimes/{runtimeId}/recording-metrics
```

```json
{
  "deliveries": 126,
  "durationMilliseconds": { "count": 126, "p50": 5, "p95": 12, "p99": 40, "max": 147 },
  "outcomes": { "recorded": 126, "relayed": 0, "deferred": 0, "rejected": 0 },
  "recording": {
    "recording-policy":          { "count": 126, "p50": 1, "p95": 3 },
    "recording-worker":          { "count": 126, "p50": 3, "p95": 7 },
    "recording-decode":          { "count": 126, "p50": 0, "p95": 0 },
    "recording-session-write":   { "count": 126, "p50": 1, "p95": 4 },
    "recording-session-claim":   { "count": 126, "p50": 0, "p95": 1 },
    "recording-directory-write": { "count": 6,   "p50": 1, "p95": 6 }
  },
  "scheduler": { "active": 1, "lanes": 1, "pending": 9 }
}
```

`durationMilliseconds` is the Relay-side cost of one reliable Session event, including the Recording Worker
round trip. `recording.*` are the Recording Worker's own measured segments, returned in
`x-mobius-recording-timing` and folded into the same snapshot, so a slow delivery can be attributed to
decoding, the Session Durable Object, the Directory Durable Object, or the binding round trip. `scheduler`
is that Runtime Relay Durable Object's queue depth, so it is scoped to one Runtime rather than the whole
deployment: `pending` is bounded at 512 before the daemon socket is closed with
`1013 runtime_message_queue_full`.

On the local side, a deferred acknowledgement makes the daemon write
`session_event_outbox_backlog` to its diagnostic log with `pendingEvents`, `pendingBytes`,
`oldestEventAgeMilliseconds`, `deadLetters`, and `standardEventBytes`. That is the durable backlog.

The snapshot lives in Durable Object memory, so it resets when the Runtime Relay object is evicted, and
percentiles become approximate once the bounded 1024-sample window wraps.

## Repeatable measurement

```sh
# Local Workers: Recording on 8788, Standalone Relay on 8787
pnpm dev:cloudflare:standalone
pnpm --dir packages/recording-cloudflare exec wrangler dev --config wrangler.jsonc --port 8788

# One Runtime, 2 Turns of 60 deltas each, daemon-equivalent window
node scripts/measure-recording-latency.ts --origin http://127.0.0.1:8787 \
  --turns 2 --deltas 60 --window 8 --poll-metrics

# Eight concurrent Runtimes, no Recording, for the Recording-free baseline
node scripts/measure-recording-latency.ts --origin https://mobius-standalone.moxt.ai \
  --sessions 8 --turns 1 --deltas 20 --window 4 --no-recording
```

The script creates an isolated Project per measurement, chooses Recording, pairs one Runtime, streams
`session.ready`, `session.started`, `agent.message.delta`, and `session.completed` through the production
Relay WebSocket with a bounded unacknowledged window, and prints client-observed latency percentiles plus
the server snapshot. `--poll-metrics` samples the server snapshot while the stream runs, because the final
read always happens after the queue has drained. Nothing is written back; the Projects it creates are
ordinary Standalone pairings.

## Measured results

Production Standalone (`https://mobius-standalone.moxt.ai`), 400-byte deltas, client-observed
acknowledgement latency. Recording enabled is the current default for the Project under test.

| Scenario | Events | p50 | p95 | max | Throughput |
| --- | --- | --- | --- | --- | --- |
| 1 Runtime, window 1, Recording on | 63 | 397 ms | 478 ms | 1754 ms | 4.5 events/s |
| 1 Runtime, window 4, Recording on | 63 | 677 ms | 1117 ms | 1515 ms | 6.4 events/s |
| 1 Runtime, window 8, Recording on | 63 | 1112 ms | 1553 ms | 2037 ms | 7.3 events/s |
| 1 Runtime, window 1, Recording off | 63 | 329 ms | 402 ms | 563 ms | 5.8 events/s |
| 1 Runtime, window 4, Recording off | 63 | 480 ms | 549 ms | 771 ms | 9.9 events/s |
| 1 Runtime, window 8, Recording off | 63 | 872 ms | 1099 ms | 1176 ms | 9.7 events/s |
| 8 Runtimes, window 4, Recording on | 184 | 695 ms | 1573 ms | 3228 ms | 42 events/s |
| 8 Runtimes, window 4, Recording off | 184 | 472 ms | 736 ms | 933 ms | 73 events/s |

Local Workers, same script, where client latency is dominated by the local loop rather than a network hop.

| Scenario | Events | p50 | p95 | Throughput | Server p50/p95 | Recording Worker p50/p95 | Peak pending |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Runtime, window 8 | 126 | 49 ms | 72 ms | 170 events/s | 5/12 ms | 3/8 ms | 9 |
| 1 Runtime, window 16 | 126 | 80 ms | 146 ms | 197 events/s | 5/12 ms | 3/7 ms | 17 |
| 8 Runtimes, window 8 | 1008 | 393 ms | 492 ms | 183 events/s | 44/73 ms | 25/46 ms | 9 |
| 8 Runtimes, window 16 | 1008 | 734 ms | 1142 ms | 177 events/s | 47/92 ms | 27/57 ms | 17 |

No measurement observed a `deferred` outcome, so no daemon-side backlog was produced.

Real Agent end-to-end, against the same local Workers with `mobius pair` and Codex:

```sh
MOBIUS_STATE_DIRECTORY=/tmp/mobius-rec-e2e/state node packages/cli/src/cli.ts pair \
  --url http://127.0.0.1:8787 --pairing <pairingId> --code <pairingCode> \
  --workspace /tmp/mobius-rec-e2e/workspace

curl -s "http://127.0.0.1:8787/mobius/api/v1/projects/<projectId>/runtimes/<runtimeId>/recording-metrics" \
  -H "Authorization: Bearer <projectToken>"
```

After two completed Codex Turns:

```json
{
  "deliveries": 8,
  "durationMilliseconds": { "count": 8, "p50": 6, "p95": 12, "p99": 12 },
  "outcomes": { "recorded": 8, "relayed": 0, "deferred": 0, "rejected": 0 },
  "recording": {
    "recording-decode":          { "count": 8, "p50": 0, "p95": 1 },
    "recording-policy":          { "count": 8, "p50": 2, "p95": 4 },
    "recording-session-write":   { "count": 8, "p50": 1, "p95": 3 },
    "recording-session-claim":   { "count": 8, "p50": 0, "p95": 1 },
    "recording-directory-write": { "count": 2, "p50": 1, "p95": 3 },
    "recording-worker":          { "count": 8, "p50": 4, "p95": 7 }
  },
  "scheduler": { "active": 0, "lanes": 0, "pending": 0 }
}
```

The same Session's recorded history contained 33 entries at that point, so `deliveries` counts reliable
delivery attempts observed by that Runtime Relay Durable Object since it was instantiated, not the recorded
total. A daemon that reconnects, or a Runtime Relay that is evicted, starts a fresh snapshot.

## What these numbers mean

- Recording is not free, but it is not the dominant cost. In production, enabling Recording added roughly
  40-230 ms to p50 and roughly 250-450 ms to p95 at matched windows, against a network round trip of about
  350 ms measured by `POST /v1/standalone/projects` from the same machine.
- Aggregate throughput fell from about 73 to about 42 events/s across 8 concurrent Runtimes with Recording
  enabled, which is consistent with the added per-event cost rather than with a saturation cliff.
- The per-event Recording write is cheap where it is measured directly. Locally the Recording Worker call was
  p50 3 ms / p95 7 ms for a single Runtime and p50 25 ms / p95 46 ms under 8 concurrent Runtimes, with the
  Session Durable Object claim itself at p95 about 1 ms. The Directory write only happens for lifecycle
  events, and its count matched the six lifecycle events rather than the 120 deltas.
- Raising the unacknowledged window increases throughput but also increases p50, because the same serial
  per-Session lane drains a deeper queue. Window 8 produced about 1.6x the throughput of window 1 at about
  2.8x the p50 latency. The 100 ms text coalescing means a single Session normally produces far fewer than
  eight events per second, so the measured window-1 throughput is a stress case rather than an interaction.
- `scheduler.pending` tracked the client window, and `active` stayed low, so the Relay queue was never close
  to its 512 limit in these runs. Peak `pending` of 17 with 8 concurrent Runtimes at window 16 is also the
  expected result rather than a limit: each Runtime has its own Relay Durable Object and its own scheduler, so
  eight Runtimes produce eight independent depths of at most the client window plus one.

## What this does not prove

These are single-machine measurements over a public network to one production deployment. The throughput
tables use a synthetic delta stream, so they bound the added Recording cost but do not establish a
multi-tenant production capacity limit; the real-Agent run above proves the metric path but is too small to
characterize Codex's event rate. Production did not expose the new server-side snapshot at measurement
time because `recording-metrics` returned `404` until this change reaches `main`; every server-side number
above comes from the local Worker stack running the same code. Fork latency at depth and Directory Durable
Object latency under many concurrent Runtimes for one Project remain unmeasured.
