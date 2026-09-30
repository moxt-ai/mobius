# Standalone Project-per-pairing E2E — 2026-09-30

## Behavior

After this change, opening a fresh Standalone pairing workflow automatically creates
one Project. The browser chooses Recording for that Project before creating its Runtime
pairing. A separate workflow creates a different Project with an independent policy.

## Repeatable setup

```sh
pnpm exec wrangler dev --config packages/recording-cloudflare/wrangler.jsonc --port 8788
pnpm dev:cloudflare:standalone
```

Open `http://localhost:8787/` in two fresh in-app browser tabs. In the first tab,
continue with Recording disabled. In the second tab, enable Recording and continue.
Both tabs must advance from `Keep durable conversation history?` to `Pair your
machine`, and each displayed pairing identifier must begin with a different `prj_`
prefix.

## Verifiable result

Run this query against the local Standalone D1 database:

```sh
pnpm --dir packages/relay-cloudflare-standalone exec wrangler d1 execute \
  DIRECTORY_DATABASE --local --config wrangler.jsonc --command \
  'SELECT p.project_id, c.enabled FROM standalone_projects p LEFT JOIN standalone_project_recording_configurations c ON c.project_id = p.project_id ORDER BY p.created_at;'
```

Observed rows:

```text
prj_J_FK7qrz4nLCUrdxhE8iZCG8 | 0
prj_iT9Tn2f_EbF3Ap02ifKeBnrz | 1
```

The distinct Project IDs prove the pairing workflows do not share a deployment-wide
Project. The `0` and `1` values prove Recording is stored independently per Project.

## Repository verification

```sh
pnpm lint
pnpm typecheck
pnpm exec vitest run packages/mobius-sdk/tests
pnpm test:integration:standalone
pnpm --filter @moxt-ai/mobius-web build
```

All commands passed. The broader Web integration command remains blocked on the
existing missing `@moxt-ai/mobius-test/agent-daemon` package export; its independent
Platform Options scenario also currently fails because the Options tab is absent.
