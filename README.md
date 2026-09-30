# Mobius

Mobius is the agent runtime and relay used by Mobius Chat. It contains the local CLI daemon and ACP agent adapter, the shared protocol, the TypeScript SDK, and Cloudflare Platform and Standalone Workers. Mobius Chat owns its user interface and application logic.

This repository starts with new database schemas. Existing Mobius data is not imported or migrated. Both Workers use sessions whose content is not retained in the cloud. Live events and active execution metadata are available while a session runs; historical content comes from the connected local runtime.

## Workspace

- `packages/cli`: local daemon, pairing, agent discovery, and ACP session execution.
- `packages/protocol`: messages shared across the daemon, Worker, and SDK.
- `packages/mobius-sdk`: client and server API used by Mobius Chat.
- `packages/mini-client`: private stateful CLI for exercising a local Platform Worker and local Runtime.
- `packages/relay-core`: runtime and session behavior, storage, and protocol boundaries.
- `packages/relay-cloudflare-platform`: Cloudflare Worker and local Worker integration tests.
- `packages/relay-cloudflare-standalone`: accountless, single-project Cloudflare Worker and integration tests.
- `tests/agent-daemon`: controlled agent integration tests.

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

Standalone runs the Relay without the Platform control plane. It has one Project named
`standalone`, a deployment-owned bearer credential, one D1 database, and a Runtime
Durable Object that also handles its Sessions. Generate a credential and start it locally:

```sh
printf 'MOBIUS_STANDALONE_TOKEN=%s\n' "$(openssl rand -hex 32)" > packages/relay-cloudflare-standalone/.dev.vars
pnpm dev:cloudflare:standalone
```

The local command applies the committed D1 migration before starting Wrangler. The
credential file is ignored by Git. The bundled Web app never receives this deployment
credential. It uses `MobiusStandaloneCredentialProvider` to obtain a short-lived,
Project-scoped browser credential, then uses `MobiusClient` for Runtime pairing,
Runtime discovery, Session history, and Session operations. The provider refreshes
the credential before expiry, and the live channel resolves it again before every
WebSocket reconnect. The old standalone
`POST /mobius/api/pairings` browser compatibility route is not available.

For an operator-driven pairing, send
`POST /mobius/api/v1/projects/standalone/runtime-pairings` with a bearer token and
`{"idempotencyKey":"my-machine"}`. For the local deployment:

```sh
export MOBIUS_STANDALONE_TOKEN="$(sed -n 's/^MOBIUS_STANDALONE_TOKEN=//p' packages/relay-cloudflare-standalone/.dev.vars)"
curl -sS -X POST http://127.0.0.1:8787/mobius/api/v1/projects/standalone/runtime-pairings \
  -H "Authorization: Bearer $MOBIUS_STANDALONE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"my-machine"}'
```

The response supplies `pairingId` and `pairingCode` for the existing CLI:

```sh
pnpm mobius pair --url http://127.0.0.1:8787 --pairing <pairingId> --code <pairingCode>
```

Operator clients can use the same deployment credential for Project and Session API
requests. Keep it private: it grants full access to this Standalone Project. Browser
apps should follow the bundled Web app and use the Standalone SDK credential provider
instead. The SDK's WebSocket transport is available at `/mobius/api/v1/transport`.
A connected local Runtime supplies Session history; the Worker does not keep
historical content after its Session object hibernates. The Standalone Worker has no
Platform identity, App, or organization routes.

The repository deploys the production Standalone Worker to
`https://mobius-standalone.moxt.ai` after `main` passes CI. The workflow deploys
the Worker and Web assets with the `MOBIUS_STANDALONE_TOKEN` GitHub environment
secret and verifies the deployed page. Before deploying the Worker, CI applies
the committed `packages/relay-core/migrations/d1` migrations to the dedicated
production D1 database with the D1 Edit-only `CLOUDFLARE_D1_API_TOKEN`
environment secret and stops the deployment if migration fails.
Self-hosted deployments need their own bearer credential and D1 binding.

## Local Runtime connections

Pairing starts or reuses one detached Mobius manager for the current user. If the
installed CLI version changes, the next `mobius pair` or `mobius start` command
stops the old manager and launches the matching version.

Run `mobius start` without options to ensure the detached daemon is running.

The daemon saves pairing credentials and connection preferences. Current turns,
delivery receipts, and pending events stay in process memory and disappear on a
restart. Codex owns its native conversation files; Mobius Chat saves which native
session IDs belong to each Bot. Bounded connection diagnostics remain in
`logs/daemon.log` under the Mobius state directory. Prompt text and session
history are not written to that log.

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

The JSON form writes the same list as an array with `connection_id`, `app_id`,
`runtime_id`, `workspace`, and `status` fields. Its target must already exist; the
CLI refuses to create it.

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [TESTING.md](./TESTING.md).
