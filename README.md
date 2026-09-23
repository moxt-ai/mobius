# Mobius

Mobius is the agent runtime and relay used by Mobius Chat. It contains the local CLI daemon and ACP agent adapter, the shared protocol, the TypeScript SDK, and Cloudflare Platform and Standalone Workers. Mobius Chat owns its user interface and application logic.

This repository starts with new database schemas. Existing Mobius data is not imported or migrated. Both Workers use sessions whose content is not retained in the cloud. Live events and active execution metadata are available while a session runs; historical content comes from the connected local runtime.

## Workspace

- `packages/cli`: local daemon, pairing, agent discovery, and ACP session execution.
- `packages/protocol`: messages shared across the daemon, Worker, and SDK.
- `packages/mobius-sdk`: client and server API used by Mobius Chat.
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
credential file is ignored by Git. To pair a machine, send
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

Use the same bearer credential for Project and Session API requests. The SDK's
WebSocket transport is available at `/mobius/api/v1/transport`. Keep the
credential private: it grants full access to this Standalone Project. A connected
local Runtime supplies Session history; the Worker does not keep historical
content after its Session object hibernates. The Standalone Worker has no
Platform identity, App, or organization routes.

For a self-hosted deployment, configure `MOBIUS_STANDALONE_TOKEN` as a Wrangler
secret, provision the `DIRECTORY_DATABASE` D1 binding, apply
`packages/relay-core/migrations/d1`, and deploy the Worker from
`packages/relay-cloudflare-standalone`. No deployment automation is configured.

No staging or production deployment workflow is configured.

## Local Runtime connections

Pairing starts or reuses one detached Mobius manager for the current user. If the
installed CLI version changes, the next `mobius pair` or `mobius start` command
stops the old manager and launches the matching version.

Manage saved Runtime pairings by their local Connection ID:

```bash
mobius pair list
mobius pair list --output-json=/path/to/existing-file.json
mobius pair stop --connection <connection-id>
mobius start --connection <connection-id>
mobius pair remove --connection <connection-id>
mobius quit
```

Stopping preserves the pairing and its `stopped` status across manager restarts.
Starting resumes the same Connection ID, while removing deletes its local
credential. `mobius pair list` shows the Connection ID, Platform App ID, Runtime
ID, workspace, and current status. Channel IDs remain internal Relay routing
identities and are not accepted as local lifecycle selectors. Older records that
predate persisted Platform App IDs display `unknown`; remove and pair them again
to record the App ID.

The JSON form writes the same list as an array with `connection_id`, `app_id`,
`runtime_id`, `workspace`, and `status` fields. Its target must already exist; the
CLI refuses to create it.

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [TESTING.md](./TESTING.md).
