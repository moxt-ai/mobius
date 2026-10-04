# Development

See [AGENTS.md](AGENTS.md) for engineering rules, [README.md](README.md) for setup
and hosting, and [TESTING.md](TESTING.md) for verification.

## Implementation map

| Concern | Authoritative implementation |
| --- | --- |
| Wire events and decoding | [session events](packages/protocol/src/session-events.ts), [messages](packages/protocol/src/messages.ts) |
| Recovery response shapes | [native sessions](packages/protocol/src/native-sessions.ts) |
| Current turn accumulation | [active turn](packages/cli/src/daemon-active-turn.ts) |
| Prompt admission, running turns and completed recovery retention | [turn registry](packages/cli/src/daemon-turn-registry.ts) |
| Local session metadata and native-session associations | [session store](packages/cli/src/acp/session-store.ts), [schema](packages/cli/src/schema/acp-session-store/) |
| Durable outbound event delivery | [publisher](packages/cli/src/relay-connection/session-event-publisher.ts), [outbox](packages/cli/src/relay-connection/session-event-outbox.ts) |
| Optional cloud recording | [Recording Worker](packages/recording-cloudflare/src/), [Worker scenarios](packages/recording-cloudflare/test/worker.integration.test.ts) |
| Ordered publication | [event coalescer](packages/cli/src/relay-connection/coalescing-agent-event-publisher.ts) |
| Native history and recovery pages | [live history](packages/cli/src/native-sessions/live-history-page.ts) |
| Agent processes and native-operation exclusion | [runtime manager](packages/cli/src/acp/agent-runtime-manager.ts), [query processes](packages/cli/src/acp/agent-query-processes.ts) |
| SDK event delivery | [client](packages/mobius-sdk/src/client.ts) |
| Deployment and migrations | [workflows](.github/workflows/), [Drizzle configurations](drizzle/) |

State transitions and retention limits belong in these implementations. Observable
contracts belong in [daemon scenarios](packages/cli/tests/),
[SDK scenarios](packages/mobius-sdk/tests/) and hosting-package tests. Do not copy
field lists or lifecycle algorithms into this guide.

## Database operations

Generate migrations using the pinned `db:generate:*` commands in
[package.json](package.json). `pnpm db:codegen` prepares ignored SQL modules for
build targets that cannot import SQL directly. Committed migrations are immutable.

Deployment workflows apply D1 migrations before deploying their consuming Workers.
Configure `CLOUDFLARE_D1_API_TOKEN` with D1 Edit separately from the deployment
`CLOUDFLARE_API_TOKEN`; both use the environment's `CLOUDFLARE_ACCOUNT_ID`.
See the workflows for exact environment bindings and failure gates.
