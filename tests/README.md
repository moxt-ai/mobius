# Shared HTTP integration infrastructure

Tests own their Hono app and all resource lifetimes. Import the infrastructure
from the private `@moxt-ai/mobius-test` workspace package when testing an embedding
application.

- `./app` exposes `createTestMobiusApp` and `createTestMobiusPlatformApp`. Both
  return the production Hono application and accept caller-owned bindings. The
  second argument is a required gateway factory. Cloudflare contract tests pass
  `createStandaloneGateways` or `createPlatformGateways`; in-process tests pass
  `() => gateways`. Shared composition never selects an adapter implicitly.
- `./agent-daemon` exposes the shared protocol-level `FakeAgentDaemon`. Web,
  SDK, Relay, Platform, and hosting tests use it instead of starting an Agent,
  ACP adapter, or production daemon.
- `./gateways` runs production Runtime, Session, and delivery logic with local
  SQLite actor storage and socket peers. Its clock is the test process's clock.
  Advance the fake clock and call `runAlarms()` to deliver due hosting alarms.
- `./cloudflare` owns local Cloudflare bindings and applies production migrations.
  These bindings are still needed for Project and Platform D1 storage.

Use `await using` for bindings, gateways, and fake Agent-daemon resources so
socket streams stop before storage is released. Pass an `AbortSignal` to every
SDK operation.

See `runtime-server.integration.test.ts` for Platform provisioning, Runtime
pairing, and Session creation through the public SDK. Prompt and event-stream
behavior is owned by the product E2E; real Agent and daemon behavior is owned by
the Agent-daemon journeys. Run the Platform embedding scenario from the Mobius
repository:

```sh
pnpm exec vitest run tests/runtime-server.integration.test.ts
```

Legacy Cloudflare HTTP suites may still expose raw protocol peers when the
transport itself is under test. Application-level scenarios use the shared fake.
