# Development

Mobius serves Mobius Chat through the Platform Worker and SDK. The Standalone Worker exposes the same Project, Runtime, and Session API without a Platform control plane. Each Standalone pairing workflow creates its own Project and Project owner credential before creating the Runtime pairing; the deployment credential remains an operator credential across those Projects. The local CLI connects to either Worker, discovers ACP agents, and executes session commands. Protocol messages cross the client, Worker, and daemon boundaries; validate them at each receiving boundary.

## Data and migrations

The project starts from new databases and has no old-data import path. Authoritative Drizzle schemas live in each package's `src/schema/<target>` directory. Generate migrations with the pinned Drizzle CLI through the `db:generate:*` scripts. Do not edit generated migration SQL. `pnpm db:codegen` prepares ignored SQL modules for targets that cannot import `.sql` directly.

After `main` passes validation, CI applies committed D1 migrations to each remote database immediately before deploying the Worker that consumes that schema. Migration failure stops that environment's deployment. CI addresses databases by their stable Cloudflare database names and authenticates migrations with environment-scoped `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_API_TOKEN` values. The D1 token grants only D1 Edit on the target account; the separate `CLOUDFLARE_API_TOKEN` retains the permissions required to deploy the Worker.

Sessions are handled in the corresponding Runtime Relay. Live delivery remains transient. An optional Recording Worker can retain the reliable Session event stream when an App or Project policy enables it; otherwise historical content remains Agent-owned on the connected local Runtime. There is no import path for previous Mobius deployments.

Recording capacity is observable rather than inferred. The Runtime Relay aggregates how long each reliable Session event took to deliver, its outcome, and the depth of its daemon message lanes; `GET /v1/projects/:projectId/runtimes/:runtimeId/recording-metrics` reports that snapshot for a Project credential. The Recording Worker returns its own measured segments in `x-mobius-recording-timing`, which the Relay folds into the same snapshot, so a slow delivery can be attributed to decoding, the Session Durable Object, the Directory Durable Object, or the binding round trip. These counters live in Durable Object memory and reset when the object is evicted. On the local side, a deferred acknowledgement makes the daemon report its durable outbox backlog as `session_event_outbox_backlog` in its diagnostic log, which is where events accumulate when Recording is slower than the Agent.

## Boundaries

Server behavior flows through HTTP or Durable Object routes, services, storage, and the database. The local daemon is the execution boundary for files, processes, and Agent operations. Validate and authorize resolved targets there. Use typed errors across subsystem boundaries, deadlines for finite external operations, and cancellation for streams.

[AGENTS.md](./AGENTS.md) has the engineering rules.

## Live execution ownership

The daemon owns pending prompts in `DaemonTurnRegistry` for its Runtime lifetime,
independently of Relay connections. The native `active-turn` result contains the
running Turn and the queued prompts (including their original images).
`session.queue.changed` invalidates the queue projection for all subscribed viewers.
Queue admission and execution are separate: requests start pending, resolve and
authorize their workspace, then validate the target and enter the queue before
`session.queued` is sent. The target command is an admission guard only. Accepted
prompts wait in Session FIFO order; completing or cancelling an earlier Turn must
not invalidate later accepted prompts. Cancelling a queued prompt removes only
that prompt. Queue snapshots contain admitted work, not unvalidated requests.

Clients read `sessions.readSessionExecution` after subscribing, on reconnect, and
on that notification. Started Turn events remove the corresponding queued entry. They must not reconstruct accepted work from a tab-local
journal. Queue changes and snapshots are transient; this adds no persisted queue.

`run-daemon.ts` composes Runtime resources; `run-relay-connection.ts` owns one
transport; `daemon-command-handler.ts` routes validated commands; the Turn registry
owns scheduling and cleanup. Prompt execution, authorized workspace resolution,
session configuration, and native history queries have separate modules.

## Agent process ownership

`AgentProcessPool` owns capacity slots from reservation through process shutdown.
A slot is starting, retained, transient, or retiring; capacity is derived from
that collection instead of synchronized counters. Retained processes share one
LRU order. The runtime manager and query-process owner supply eligibility and cleanup for
execution and query processes, so active or borrowed processes cannot be
evicted. The maximum remains ten processes.

`AgentConnection` owns the Agent transport, process tree, termination signal, and
request cancellation/error translation. `AcpSessionInteractions` owns pending
permission and elicitation responses and their cancellation. `AgentSession`
owns the session's ACP operations and streamed content. `AgentRuntimeManager`
coordinates session preparation, native identity, and execution.

`AgentQueryProcesses` owns query process preparation, reuse, borrowing, replacement,
and retirement, including its private observer and in-memory store. It shares the
capacity pool with execution, but never the execution cache or process. Preview
continues using an isolated transient process; a preview cannot change the selected
native session of a retained directory browser. The manager coordinates native
operation exclusion and linked execution sessions without managing query resources.

Each of the two independent `RetainedAgentProcesses` caches owns a single entry per
session: its resource/preparation lifecycle and its scoped borrower count. The
execution cache and history-browser cache never share an entry or process.
`prepare` registers the pending operation before starting it and clears it on
success or failure; replacement can detach the old resource and retain the new
one while preparation still owns the entry. `use` balances every borrow in a
`finally` block. Detaching checks resource identity, so stale cleanup cannot
remove a replacement. An empty entry with no preparation or borrower is removed.

`ActiveExecutions` owns one discriminated state per executing/cancelled session:
running, cancelling, or cancellation received before execution starts. Duplicate
cancellation joins the same completion. Cancellation stays attached until the
matching command finishes, preserving the existing early-cancellation behavior.
Native import/preview/delete exclusion remains keyed by Agent and native session
in the manager; it is distinct from process borrowing and turn execution.

These boundaries preserve existing public protocol, session storage, cancellation,
and native-history behavior. Queue ownership remains in `DaemonTurnRegistry`.

## Testing boundaries

Web / Chat tests use real product services, transports, and daemon with a stateful
controlled Agent harness. Separate compatibility tests use the real Agent
executables, and production adapters for Codex, Claude Code, OpenCode, and Pi.
Keep each Agent's adaptation coverage independent. See [TESTING.md](./TESTING.md)
for provider exceptions, commands, and the current coverage gaps.

## Daemon vocabulary and state owners

A native session is an Agent-owned conversation identity/history. An Agent process
is a reusable execution resource, not stored conversation content. An execution is
one active command. Borrowing a process prevents eviction; it does not create a turn.

| Module | Owned state and responsibility |
| --- | --- |
| `agent-runtime-manager.ts` / `AgentRuntimeManager` | Coordinates execution preparation and native-operation exclusion; owns execution process registry and active execution tracker. |
| `agent-query-processes.ts` / `AgentQueryProcesses` | Owns query process registry, private observer/store, preparation and retirement; isolates previews. |
| `retained-agent-processes.ts` / `RetainedAgentProcesses` | Owns each cached resource's preparation state and borrower count; execution and query use separate instances. |
| `agent-process-pool.ts` / `AgentProcessPool` | Owns shared process capacity slots and LRU order. |
| `active-executions.ts` / `ActiveExecutions` | Owns active command identity and cancellation completion. |
| `agent-session.ts` / `AgentSession` | Owns native conversation operations, configuration, replay mode and turn content; composes a connection and update stream. |
| `agent-connection.ts` / `AgentConnection` | Owns transport, process tree and termination; translates request cancellation/errors. |
| `agent-update-stream.ts` / `AgentUpdateStream` | Owns native identity selection, bounded pre-selection notifications and ordered notification delivery. Selection drops the pre-selection buffer and byte count. |

These are internal names. CLI package exports, daemon command/event schemas,
Agent adaptation and native-session identifiers are unchanged. Query and execution
processes remain distinct, and accepted queued prompts still belong to
`DaemonTurnRegistry`. Native history remains Agent-owned.

`RuntimeOperations` owns in-flight cancellable requests. Closing the Runtime aborts
those requests and waits for their resource cleanup before retiring retained
processes. Preparation borrowers wait with their own cancellation signal; cancelling
a borrower does not cancel the request that owns the shared preparation. Text chunks
and activity tracking live in the same `AcpTurnState` and are released together when
that turn finishes. Codex configuration and model discovery belong to `CodexSettings`;
its next-turn parameters are consumed by the execution owner.

## Live events and current turn recovery

The daemon publishes bounded `agent.message.delta`, `agent.activity`,
`agent.activity.narration`, and `agent.content` events while a Turn runs. One
ordered coalescer bounds publication frequency while combining only compatible
adjacent Agent events. Live events never carry the complete accumulated Turn.

`ActiveDaemonTurn` separately accumulates an ordered in-memory recovery snapshot.
The snapshot has one canonical `messages` timeline; it does not duplicate prompt,
text, activities, or content in parallel top-level fields. The `active-turn` and
live-history queries read that snapshot only on demand for a
new viewer, refresh, or reconciliation. A new activity keeps its first timeline
position while later status updates replace its value. Activity sequence is display
order; Turn sequence versions the recovery snapshot. Native history is used for
completed Turns; its partial current-turn output must not override the daemon
snapshot. Final output is flushed before completion and Turn memory is released by
the execution registry. No cloud event log is added.

Web integration tests run the production daemon and control only its Agent harness.
Real Agent tests verify the production daemon's cumulative output, tool state, and
native-session recovery. Controlled Agent peers cover burst coalescing and lifecycle
faults; they do not establish real Agent compatibility.
