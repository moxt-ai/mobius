# Development

See [AGENTS.md](AGENTS.md) for engineering rules, [README.md](README.md) for setup
and hosting, and [TESTING.md](TESTING.md) for verification.

## Design rationale

The [product goals](README.md#functional-value) explain why the system exists.
Implementation choices must serve those goals without turning the README into a
second protocol specification.

ACP supplies client-to-Agent interaction. Using it does not by itself prove that a
user can securely reach their machine remotely, switch devices, see another client's
prompt or recover after disconnecting. Mobius must provide those user experiences
while reusing the Agent's operations rather than inventing parallel semantics.

Current-turn recovery is difficult because a user may return while work is still
changing, before native history contains the result. Execution completion, delivery
and history availability must remain separate. The daemon owns the current execution
view; clients must recover prior content and continue receiving updates without gaps,
duplication or output disappearing during history handoff. The concrete transitions
and recovery algorithm belong in code and boundary tests.

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

## Current persistence behavior

The following describes current behavior, including its limitations. It does not
by itself justify adding storage or promise durable execution recovery:

- The local daemon persists pairing credentials, connection preferences, ACP session
  metadata and native-session associations, and a bounded event outbox. Event payloads
  can contain conversation content; disabling cloud Recording does not disable this
  local persistence. The outbox supports delivery recovery, not a complete history archive.
- Current execution and queued prompts are held in memory. Restarting the daemon does
  not durably resume a running turn or its prompt queue. Persisted session metadata and
  pending outbox events survive a restart; event delivery recovery must not be presented
  as execution recovery.
- Without Recording, browsing native history requires the local Runtime and the Agent's
  saved history. With the optional Recording Worker installed and recording enabled for
  an App or Project, cloud history is available according to that recording policy.
- Bounded local diagnostics are for troubleshooting and must not log prompt text or
  session history. This log restriction is separate from the outbox's payload storage.

See the implementation map above for storage and delivery owners. Exact
schemas, acknowledgement rules and capacity limits belong in code and executable tests.


## Workspace

- `packages/cli`: local daemon, pairing, agent discovery, and ACP session execution.
- `packages/protocol`: messages shared across the daemon, Worker, and SDK.
- `packages/mobius-sdk`: client and server API used by Mobius Chat.
- `packages/mini-client`: private stateful CLI for exercising a local Platform Worker and local Runtime.
- `packages/relay-core`: runtime and session behavior, storage, and protocol boundaries.
- `packages/relay-cloudflare-platform`: Cloudflare Worker and local Worker integration tests.
- `packages/relay-cloudflare-standalone`: accountless Cloudflare Worker with one Project per pairing workflow and integration tests.
- `packages/recording-cloudflare`: optional cloud history service.
- `packages/cli/tests`: daemon boundary scenarios and real Agent compatibility tests.
