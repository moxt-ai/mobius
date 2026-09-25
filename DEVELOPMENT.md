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

## Testing boundaries

Web / Chat tests use real product services and transports with a stateful fake
daemon. Separate agent-daemon integration tests use the real daemon, real Agent
executables, and production adapters for Codex, Claude Code, OpenCode, and Pi.
Keep each Agent's adaptation coverage independent. See [TESTING.md](./TESTING.md)
for provider exceptions, commands, and the current coverage gaps.
