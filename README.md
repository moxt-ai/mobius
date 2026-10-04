# Mobius

Mobius lets remote clients securely use Agents running on a user's machine and
follow their conversations across browser and network connections. Morty (Mobius
Chat) is one application built on it; Standalone provides access without the
Platform control plane.

## Product responsibilities

| Capability | Required user-visible outcome |
| --- | --- |
| Pair and discover Runtimes | Users can identify their machines, installed Agents and availability. |
| Discover Agent capabilities | Clients offer supported operations and settings; unsupported operations fail explicitly. |
| Operate native sessions | Users can create or resume a conversation, submit or queue prompts, cancel execution and answer Agent interactions where supported. |
| Follow current execution | Authorized clients can observe the same conversation, including prompts submitted from another browser and in-progress output. |
| Read history and files | Users can recover available history and view authorized files, including images, without obtaining arbitrary access to the machine. |
| Optional Recording | Operators can explicitly enable cloud history retention with a defined scope and policy. |

Morty owns Bots, user access and application presentation. Mobius owns remote
connectivity, operation routing, Agent adaptation and synchronization. Agents own
model execution, tool execution and native conversation history. The local execution
boundary authorizes local side effects; application authorization cannot bypass it.

The requirements below are design constraints. They are not a claim that every Agent
or failure scenario is already covered. Compatibility claims require executable
boundary scenarios; see [Testing](TESTING.md).

## Non-functional requirements

- **Security:** authorize the resolved local target before acting. Access to a
  conversation must not imply access to arbitrary files, commands or other tenants.
- **Privacy:** distinguish local persistence, cloud transit, cloud retention and
  diagnostic logs. Changes to stored content, retention scope or deletion behavior
  require an explicit product decision and observable verification.
- **Consistency:** session writes have a defined admission order. Concurrent submissions
  and retries must not silently overwrite work or execute a prompt twice. Authorized
  observers must converge on the same accepted prompts, output and terminal outcome.
- **Recovery:** a browser disconnect must not itself cancel execution. Reconnection
  must restore an authoritative view or report that recovery is unavailable. Unknown,
  running, cancelled, failed and completed outcomes must remain distinguishable;
  receipt of a command or event alone does not prove execution completed.
- **Responsiveness:** loading old history must not block current-turn presentation.
  Slow subscribers must not stall the Agent or other observers. Agent limitations and
  omitted history must be disclosed rather than presented as a complete conversation.
- **Resource ownership:** current-turn memory may retain enough content for reliable
  recovery. Completion, history handoff and expiry need explicit release conditions;
  caches, queues, logs and disk-backed delivery need bounded retention. Limit failures
  must be observable. Exact thresholds and transitions belong in code and tests.

## Why ACP needs a remote-session layer

ACP provides the client-to-Agent interaction boundary used by the adapters. Mobius
should reuse Agent operations and capabilities expressed there. A working ACP
connection alone does not establish Mobius's remote identity, pairing, tenant and
file authorization, multiple-subscriber delivery, reconnect recovery, retry safety
or optional cloud retention guarantees.

Mobius must supply those guarantees at its own boundaries and accommodate differences
between Agent implementations. Agent-specific protocol and history behavior belongs
in adapters. Do not introduce a parallel Agent operation model where the existing
Agent protocol already provides the required semantics.

## Why the current turn needs an explicit owner

During a turn, accepted prompts, streamed text, tool progress and pending interactions
change before the Agent's native history necessarily contains a complete result.
Execution completion, event delivery and history visibility are separate facts.

The daemon owns the authoritative view of current execution; browsers display that
view. A new or reconnecting observer must recover the content produced before it
joined and continue receiving updates without a gap or duplicate presentation. It
must see prompts accepted from other clients, and stale responses from a previously
selected session must not overwrite the newly selected conversation.

For example, if one browser submits a prompt, another joins midway and the first
reconnects after completion, both must recover the same accepted prompt and result.
A delayed history read must not erase already displayed output. Cancellation racing
with completion must resolve to a coherent terminal outcome.

Recovery content must remain available until the authoritative history source can
take over, or recovery expiry must be explicitly reported. Keeping current-turn
content in memory is acceptable; reconstructing it independently in every browser
must not become a competing source of truth. The representation, sequence numbers,
acknowledgements and handoff algorithm belong in executable code, not a second
state machine written in this README.

## Data ownership and recovery

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

See the [implementation map](DEVELOPMENT.md) for storage and delivery owners. Exact
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

## Local development

Use Node and pnpm versions from `.nvmrc` and `package.json`.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` starts the local Platform Worker. Committed migrations under `packages/*/migrations` define fresh local databases; `pnpm db:codegen` generates ignored SQL import modules used by the Worker and tests.

## Standalone Worker

Standalone runs the Relay without the Platform control plane. Each browser pairing
workflow automatically creates a Project and a Project owner credential. A separate
deployment-owned bearer credential can administer every Project. Generate the deployment credential and start it locally:

```sh
printf 'MOBIUS_STANDALONE_TOKEN=%s\n' "$(openssl rand -hex 32)" > packages/relay-cloudflare-standalone/.dev.vars
pnpm dev:cloudflare:standalone
```

The local command applies the committed D1 migration before starting Wrangler. The
credential file is ignored by Git. The bundled Web app never receives this deployment
credential. Its deployment adapter creates a Project and its Project-scoped owner
credential, then uses the generic `MobiusClient` for Runtime pairing,
Runtime discovery, Session history, and Session operations. The browser persists the
Project credential after pairing so page loads and WebSocket reconnects return to the
same Project.

For an operator-driven pairing, first send `POST /mobius/api/v1/standalone/projects`
to create a Project, then send `POST /mobius/api/v1/projects/{projectId}/runtime-pairings`
with either its returned Project credential or the deployment credential and
`{"idempotencyKey":"my-machine"}`.

```sh
curl -sS -X POST http://127.0.0.1:8787/mobius/api/v1/standalone/projects

curl -sS -X POST http://127.0.0.1:8787/mobius/api/v1/projects/<projectId>/runtime-pairings \
  -H "Authorization: Bearer <projectToken>" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"my-machine"}'
```

The response supplies `pairingId` and `pairingCode` for the existing CLI:

```sh
pnpm mobius pair --url http://127.0.0.1:8787 --pairing <pairingId> --code <pairingCode>
```

Operator clients can use the same deployment credential for Project and Session API
requests. Keep it private: it grants full access to every Standalone Project. Browser
apps should follow the bundled Web app and keep the Project credential inside their
deployment integration. The SDK's WebSocket transport is available at `/mobius/api/v1/transport`.
A connected local Runtime supplies Session history when Recording is disabled. When
Recording is installed and enabled for a Standalone Project during pairing, the Web
app loads that Project's durable history from Recording instead. The Standalone Worker
acts as one deployment-owned Platform principal, but does not expose the hosted
Platform's identity, App, or organization control-plane routes.

The repository deploys the production Standalone Worker to
`https://mobius-standalone.moxt.ai` after `main` passes CI. The workflow deploys
the Worker and Web assets with the `MOBIUS_STANDALONE_TOKEN` GitHub environment
secret and verifies the deployed page. Before deploying the Worker, CI applies
the committed `packages/relay-cloudflare-standalone/migrations/d1` migrations to the dedicated
production D1 database with the D1 Edit-only `CLOUDFLARE_D1_API_TOKEN`
environment secret and stops the deployment if migration fails.
Self-hosted deployments need their own bearer credential and D1 binding.

## Local Runtime connections

Pairing starts or reuses one detached Mobius manager for the current user. If the
installed CLI version changes, the next `mobius pair` or `mobius start` command
stops the old manager and launches the matching version.

Run `mobius start` without options to ensure the detached daemon is running.

Manage saved Runtime pairings by their local Connection ID:

```bash
mobius pair list
mobius pair list --output-json=/path/to/existing-file.json
mobius pair stop --connection <connection-id>
mobius start
mobius start --connection <connection-id>
mobius pair remove --connection <connection-id>
mobius quit
```

Stopping preserves the pairing and its `stopped` status across manager restarts.
Starting resumes the same Connection ID, while removing deletes its local
credential. `mobius pair list` shows the Connection ID, Platform App ID, Runtime
ID, workspace, and current status. Channel IDs remain internal Relay routing
identities and are not accepted as local lifecycle selectors.

For machine-readable output, use `--output-json` with an existing file. The CLI
refuses to create the target; command help and executable scenarios define its output contract.

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [TESTING.md](./TESTING.md).
