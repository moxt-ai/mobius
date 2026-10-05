# Development

See [AGENTS.md](AGENTS.md) for engineering rules, [README.md](README.md) for setup
and hosting, and [TESTING.md](TESTING.md) for verification.

## Design rationale

The [product goals](README.md#why-mobius-exists) explain why the system exists.
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
  metadata and native-session associations. Agents retain their own native history.
- Current execution and queued prompts are memory-only. The daemon publishes live
  events without an application delivery queue. Reconnection resumes live output;
  shutdown or a crash loses in-flight messages and queued work by design.
- Relay live delivery does not persist event receipts or wait for consumers to
  acknowledge delivery. Recording runs independently with bounded buffering and a
  deadline. Failed or overloaded recording attempts are dropped, never retried.
  This implements the chosen [latency and reliability tradeoff](README.md#why-mobius-exists).
- Without Recording, browsing native history requires the local Runtime and the Agent's
  saved history. With the optional Recording Worker installed and recording enabled for
  an App or Project, cloud history is available according to that recording policy.
- Bounded local diagnostics are for troubleshooting and must not log prompt text or
  session history. Diagnostics must not become a replacement event archive.

Exact schemas, state transitions, and capacity limits belong in code and executable
tests; do not duplicate them in this guide.
