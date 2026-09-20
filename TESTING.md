# Testing

Tests are a small executable control surface for Mobius. Keep four shapes and no
more:

1. `e2e/mobius.e2e.test.ts` owns the critical successful product journey.
2. Boundary tests enter through one production boundary and own its failures.
3. `packages/protocol/tests` owns serialization and trust-boundary contracts.
4. `tests/agent-daemon/cases` owns compatibility with real third-party Agents.

Runner, package, and CI partition names are implementation details, not additional
test levels.

## Product journey

The E2E journey enters through the public SDK and production CLI and crosses the
Relay, daemon, ACP, filesystem, and Agent boundaries. Extend this journey before
adding another E2E case. It should prove a long path instead of enumerating edge
cases.

## Boundary tests

A boundary test uses the production entrypoint for the behavior it owns:

- CLI tests use the executable, daemon, filesystem, SQLite, or ACP boundary.
- SDK tests use the public client and transport.
- Web tests mount the complete application against the local Relay.
- hosting tests use the production Worker with local Cloudflare bindings.
- `tests/runtime-server.integration.test.ts` uses the embedding API and SDK.

Do not test a private helper or class in isolation. Do not repeat a successful
path already owned by a longer test. Add a narrower case only for a distinct risk:
authorization, corruption, cancellation, recovery, cleanup, concurrency, quota,
or external compatibility.

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

Use fixed clocks and explicit advancement for time-dependent behavior. Wait for
the event or visible state that proves progress. A bounded timeout is failure
containment, not synchronization.

## Commands

The normal developer surface is intentionally small:

```bash
pnpm test
pnpm test:e2e
pnpm test:agent-daemon
```

Package-specific integration commands exist only for focused iteration. Coverage
and `client`, `relay`, and `hosting` partitions are CI plumbing and do not define
new kinds of tests.

Run `pnpm lint`, `pnpm typecheck`, and the affected test command locally. Reserve
`pnpm ci:check` for CI.

## CI

CI partitions deterministic tests by runtime so they can run in parallel. Real
Agent compatibility cases use a diff-selected matrix. Coverage is advisory and
cannot prove an end-to-end path, especially when code runs in a subprocess or a
separately bundled Worker.

Architecture rules remain executable in `dependency-cruiser.config.cjs`.
