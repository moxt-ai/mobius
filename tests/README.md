# Shared HTTP integration infrastructure

Tests own their Hono app and all resource lifetimes. Import the infrastructure
from the private `@moxt-ai/mobius-test` workspace package when testing an embedding
application.

- `./app` exposes `createTestMobiusApp` and `createTestMobiusPlatformApp`. Both
  return the production Hono application and accept caller-owned bindings. The
  second argument is a required gateway factory. Cloudflare contract tests pass
  `createStandaloneGateways` or `createPlatformGateways`; in-process tests pass
  `() => gateways`. Shared composition never selects an adapter implicitly.
- `./agent` exposes a stateful local ACP process. It requires no provider account.
- `./runtime` starts the production Runtime and exposes `client` (Session SDK),
  `runtimeId`, and cancellable `waitForBinding`.
  SDK HTTP requests go directly through the supplied Hono application. The
  Runtime's WebSocket transport uses an ephemeral loopback server owned by the
  helper.
- `./gateways` runs production Runtime, Session, and delivery logic with local
  SQLite actor storage and socket peers. Its clock is the test process's clock.
  Advance the fake clock and call `runAlarms()` to deliver due hosting alarms.
- `./cloudflare` owns local Cloudflare bindings and applies production migrations.
  These bindings are still needed for Project and Platform D1 storage.

Use `await using` for bindings, gateways, Agent, and Runtime, in that order, so
the Runtime and its SDK streams stop before storage is released. Pass an
`AbortSignal` to Runtime creation and every SDK operation.

See `runtime-server.integration.test.ts` for Platform pairing and a complete
Session prompt/event-stream exchange. Run this scenario from the Mobius repository:

```sh
pnpm exec vitest run tests/runtime-server.integration.test.ts
```

Migration status: the legacy Cloudflare HTTP suites still contain manual
protocol setup helpers. The new Runtime/SDK scenarios establish the replacement
path; those suites and embedding-application fixtures are not fully migrated.
