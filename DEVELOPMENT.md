# Development

Mobius serves Mobius Chat through the Platform Worker and SDK. The Standalone Worker exposes the same Project, Runtime, and Session API under a single deployment-owned Project. The local CLI connects to either Worker, discovers ACP agents, and executes session commands. Protocol messages cross the client, Worker, and daemon boundaries; validate them at each receiving boundary.

## Data and migrations

The project starts from new databases and has no old-data import path. Authoritative Drizzle schemas live in each package's `src/schema/<target>` directory. Generate migrations with the pinned Drizzle CLI through the `db:generate:*` scripts. Do not edit generated migration SQL. `pnpm db:codegen` prepares ignored SQL modules for targets that cannot import `.sql` directly.

Sessions are handled in the corresponding Runtime Relay. Session content is not retained in cloud storage. Do not add a retained-content mode or a migration path for previous Mobius deployments.

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

`AcpProcessPool` owns capacity slots from reservation through process shutdown.
A slot is starting, retained, transient, or retiring; capacity is derived from
that collection instead of synchronized counters. Retained processes share one
LRU order. The session manager supplies eligibility and cleanup for execution
sessions and native-history browsers, so active or borrowed processes cannot be
evicted. The maximum remains ten processes.

`AcpEndpoint` owns the Agent transport, process tree, termination signal, and
request cancellation/error translation. `AcpSessionInteractions` owns pending
permission and elicitation responses and their cancellation. `AcpProcessSession`
owns the session's ACP operations and streamed content. `AcpSessionManager`
coordinates session preparation, native identity, and execution.

`NativeSessionBrowsers` owns query process preparation, reuse, borrowing, replacement,
and retirement, including its private observer and in-memory store. It shares the
capacity pool with execution, but never the execution cache or process. Preview
continues using an isolated transient process; a preview cannot change the selected
native session of a retained directory browser. The manager coordinates native
operation exclusion and linked execution sessions without managing query resources.

Each of the two independent `RetainedSessions` caches owns a single entry per
session: its resource/preparation lifecycle and its scoped borrower count. The
execution cache and history-browser cache never share an entry or process.
`prepare` registers the pending operation before starting it and clears it on
success or failure; replacement can detach the old resource and retain the new
one while preparation still owns the entry. `use` balances every borrow in a
`finally` block. Detaching checks resource identity, so stale cleanup cannot
remove a replacement. An empty entry with no preparation or borrower is removed.

`SessionExecutions` owns one discriminated state per executing/cancelled session:
running, cancelling, or cancellation received before execution starts. Duplicate
cancellation joins the same completion. Cancellation stays attached until the
matching command finishes, preserving the existing early-cancellation behavior.
Native import/preview/delete exclusion remains keyed by Agent and native session
in the manager; it is distinct from process borrowing and turn execution.

These boundaries preserve existing public protocol, session storage, cancellation,
and native-history behavior. Queue ownership remains in `DaemonTurnRegistry`.

## Testing boundaries

Web / Chat tests use real product services and transports with a stateful fake
daemon. Separate agent-daemon integration tests use the real daemon, real Agent
executables, and production adapters for Codex, Claude Code, OpenCode, and Pi.
Keep each Agent's adaptation coverage independent. See [TESTING.md](./TESTING.md)
for provider exceptions, commands, and the current coverage gaps.
