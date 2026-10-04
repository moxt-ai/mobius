# Mobius

Mobius is the agent runtime and relay used by Mobius Chat. It contains the local CLI daemon and ACP agent adapter, the shared protocol, the TypeScript SDK, and Cloudflare Platform and Standalone Workers. Mobius Chat owns its user interface and application logic.

## Data ownership and recovery

Morty owns Bot membership and access to conversations. The local Agent owns its
native conversation and execution. Mobius connects those boundaries and can provide
optional cloud recording; it must not imply that every deployment retains history.

The current implementation has these storage boundaries:

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
