# Testing

Tests are a small executable control surface for Mobius. Keep four shapes and no
more:

1. `e2e/mobius.e2e.test.ts` owns the critical successful server product journey.
2. Boundary tests enter through one production boundary and own its failures.
3. `packages/protocol/tests` owns serialization and trust-boundary contracts.
4. `tests/agent-daemon` owns the complete local Agent and daemon boundary.

Runner, package, and CI partition names are implementation details, not additional
test levels.

## Agent and daemon boundary

Treat an Agent and the production Mobius daemon as one integration unit. Only
`tests/agent-daemon` tests that unit. `controlled-agent/` runs the production
daemon against one controllable ACP Agent for deterministic failure, recovery,
storage, security, and lifecycle behavior.
`real/` uses each real Agent executable, its production ACP adapter and provider
client, the production daemon, and a permissive local fake LLM provider.

Every suite that consumes the Agent-daemon unit talks to a shared protocol-level
`FakeAgentDaemon`. The fake claims a Runtime, connects through the production
daemon/server WebSocket protocol, and emits normal workspace, Session, event,
and file-transfer messages. It does not start an Agent, ACP adapter, daemon
process, or `MobiusRuntimeEngine`. Do not introduce another fake ACP Agent or
embed a private daemon simulator in one package's harness.

This boundary keeps responsibility unambiguous:

- Agent-daemon cases prove Agent discovery, configuration, provider access,
  tool execution, ACP translation, and daemon delivery.
- Web, SDK, Relay, Platform, and hosting tests prove their behavior against the
  public daemon/server protocol without retesting the Agent-daemon unit.
- Protocol contract tests prove message validation and round trips without a
  process or network.

There is no separate CLI test level or shell-wrapper suite. Discovery,
installation, ACP translation, local storage, and Relay delivery belong to this
same unit and live under `tests/agent-daemon/controlled-agent`. They must not be
copied into a consumer suite. Help text, argument parsing, and other
command-shell details do not justify integration tests.

An exceptional E2E may start the production daemon only when that executable
assembly is itself the behavior being proved. Keep such cases rare, explicit,
and separate from the normal server journey. Needing an Agent response is not a
reason to take the exception.

## Product journey

The normal E2E journey enters through the public SDK, crosses the production
Relay, and uses `FakeAgentDaemon` at the daemon/server boundary. Extend this
journey before adding another E2E case. It should prove a long server path
instead of enumerating edge cases or repeating Agent-daemon compatibility.

## Boundary tests

A boundary test uses one production entrypoint for the behavior it owns. A package
directory does not define a new test level:

- Agent-daemon workflows enter through the daemon protocol. Direct Agent,
  process, filesystem, or SQLite tests are reserved for security, corruption,
  and recovery behavior that the outer boundary cannot create cheaply.
- SDK tests use the public client and transport.
- Web tests mount the complete application against the local Relay and shared
  `FakeAgentDaemon`.
- hosting tests use the production Worker with local Cloudflare bindings.
- `tests/runtime-server.integration.test.ts` uses the public SDK against the
  production Platform Worker, Durable Objects, and Runtime protocol. The shared
  `startTestPlatform` helper owns only startup, credentials, migrations, and cleanup.

Do not test a private helper or class in isolation. Do not repeat a successful
path already owned by a longer test. Add a narrower case only for a distinct risk:
authorization, corruption, cancellation, recovery, cleanup, concurrency, quota,
or external compatibility.

Keep one file per behavioral owner. Do not create parallel `direct`, `service`, or
`manager` suites for the same operation; extend the existing owner and fold shared
outcomes into its longest representative journey.

Name shared daemon and ACP behavior after the behavior. Name vendor-specific
discovery, configuration, and compatibility after the concrete Agent, because
those cases define that vendor adapter's contract.

Prefer one journey that advances through related states over several cases that
recreate the same expensive setup. A case should stop when its owning boundary has
proved its result; internal timing headers, compression choices, call ordering,
and other implementation details are not product contracts.

## State

Prepare prerequisites through the cheapest production business operation at the
tested boundary. Shared support code owns processes, ports, credentials,
migrations, waiting, diagnostics, and cleanup. It must not hide the business
action being tested.

Direct persistence setup is reserved for storage and migration tests or state
owned by an upstream system. Name that setup explicitly. Use a stateful fake only
for an external dependency that cannot run safely or deterministically; connect to
it through the production port.

Shared fakes replace shared boundaries. Do not create package-local mocks of the
Agent-daemon protocol.

Use fixed clocks and explicit advancement for time-dependent behavior. Wait for
the event or visible state that proves progress. A bounded timeout is failure
containment, not synchronization.

## Commands

The normal developer surface is intentionally small:

```bash
pnpm test
pnpm test:agent-daemon
pnpm test:e2e
```

`pnpm test` runs deterministic controlled-Agent coverage plus the same `client`,
`relay`, and `hosting` partitions that CI runs in parallel.
`pnpm test:agent-daemon` additionally runs real-Agent compatibility; CI selects
and parallelizes affected real Agents. Those partitions are execution plumbing,
not new kinds of tests.
Package-specific integration commands exist only for focused iteration. Run
`pnpm test:coverage` explicitly when coverage is useful for investigation;
normal test execution does not collect it.

Run `pnpm lint`, `pnpm typecheck`, and the affected test command locally.
`pnpm ci:check` serially reproduces the complete static and deterministic test
surface when combined CI diagnosis is necessary.

## CI

CI partitions deterministic tests by runtime so they can run in parallel. Real
Agent compatibility cases use a diff-selected matrix. CI runs normal tests rather
than producing coverage artifacts that no check consumes. Coverage remains an
explicit, advisory diagnostic because it cannot prove an end-to-end path,
especially when code runs in a subprocess or a separately bundled Worker.

Architecture rules remain executable in `dependency-cruiser.config.cjs`.
