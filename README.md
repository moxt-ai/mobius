# Mobius

Mobius is the agent runtime and relay used by Mobius Chat. It contains the local CLI daemon and ACP agent adapter, the shared protocol, the TypeScript SDK, and a Cloudflare Platform Worker. Mobius Chat owns its user interface and application logic.

This repository starts with new database schemas. Existing Mobius data is not imported or migrated. The Platform Worker supports only sessions whose content is not retained in the cloud. Live events and active execution metadata are available while a session runs; historical content comes from the connected local runtime.

## Workspace

- `packages/cli`: local daemon, pairing, agent discovery, and ACP session execution.
- `packages/protocol`: messages shared across the daemon, Worker, and SDK.
- `packages/mobius-sdk`: client and server API used by Mobius Chat.
- `packages/relay-core`: runtime and session behavior, storage, and protocol boundaries.
- `packages/relay-cloudflare-platform`: Cloudflare Worker and local Worker integration tests.
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

No staging or production deployment workflow is configured.

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [TESTING.md](./TESTING.md).
