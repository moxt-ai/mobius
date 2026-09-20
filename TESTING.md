# Testing Guide

## Purpose

Tests are a small executable control surface for a large codebase. A maintainer
should be able to read the representative journeys and boundary scenarios and
understand what Mobius promises without reading every implementation package.

Each behavior has one primary owner:

- an end-to-end journey owns a critical successful product path;
- an integration test owns behavior at one production boundary;
- a contract test owns serialization, trust, or external compatibility.

Repeat behavior at another level only for a distinct high-impact risk such as
authorization, destructive side effects, data integrity, cancellation, resource
cleanup, or protocol compatibility. Coverage is supporting evidence, not a reason
to duplicate a scenario.

## Levels and locations

### End to end

`e2e/mobius.e2e.test.ts` is the product control surface. It enters through the
public SDK and production CLI, then crosses Relay, daemon, ACP, filesystem, and
Agent boundaries. Keep it to a few long happy-path journeys. Extend an existing
journey before adding another one.

A scenario is end to end only when it uses the same supported entrypoint and
production composition as a user. Test-owned ports, credentials, temporary files,
and process lifecycle are allowed. Calling an internal service in place of a
public step is not.

### Agent and daemon

`tests/agent-daemon/cases` treats each real third-party Agent and the production
daemon as one integration. The test talks through the Mobius server protocol; a
local fake LLM provider replaces only the hosted model. Each Agent has one case
and all cases share `tests/agent-daemon/infra/journey.ts`. See the directory README
for provider and diagnostic rules.

### Integration

An integration test enters through one production boundary and uses its real
collaborators behind that boundary:

- `packages/cli/tests`: CLI, daemon, subprocess, filesystem, SQLite, and ACP;
- `packages/mobius-sdk/tests`: public SDK and transport;
- `packages/web/test`: complete Web application, local Relay, and WebSocket;
- `packages/relay-cloudflare-standalone/test`: Standalone Worker and local
  Cloudflare bindings;
- `packages/relay-cloudflare-platform/test`: Platform Worker and local Cloudflare
  bindings;
- `tests/runtime-server.integration.test.ts`: embedding API, Platform, Runtime,
  and SDK composition.

Integration tests may use public APIs, temporary filesystems, subprocesses,
sockets, local protocol servers, D1, Durable Objects, and R2. They must not test a
private class or helper in isolation. Renaming such a test to `integration` does
not change its level: move its assertion to the owning boundary or remove it when
a stronger scenario already owns the behavior.

Web integration is the only integration family driven through mouse and keyboard.
It mounts the complete `App` in Happy DOM and uses Wrangler's local Worker harness.
Do not render individual components, call Zustand actions, replace `fetch`, or
patch production modules. Browser-specific layout remains manual unless it becomes
a supported behavior requiring real-browser coverage.

### Contract

`packages/protocol/tests` owns message direction, schema round-trips, resource
states, bounded inputs, and trust-boundary rejection. A contract test should be
smaller than product composition because the protocol itself is the supported
boundary.

## Scenario shape

Write titles as executable specifications:

```text
Given [observable context], When [an actor performs an action], Then [an observable result occurs]
```

Assert only observable contracts: returned results, protocol messages, persisted
state, emitted events, filesystem effects, process status, accessible DOM, and
typed errors. Do not assert private calls, incidental ordering, or implementation
details. A refactor that preserves the boundary contract should preserve the test.

Behavior changes start with a failing scenario at the highest boundary that owns
the behavior. Documentation-only and mechanical changes do not require a new test.

## State and external dependencies

Prepare state through the cheapest production business operation available at
the tested boundary. Each composition level has one shared harness that owns
startup, credentials, waiting, diagnostics, and cleanup. Tests vary the business
state, not the infrastructure recipe.

Direct persistence setup is reserved for storage and migration boundaries, or for
state owned by an upstream component outside the test. Keep either use explicit.

Mocks, spies, module replacement, monkey patching, and canned request interceptors
are prohibited. When a real external service cannot run safely or deterministically,
use one stateful fake at its production port. The fake implements the external
contract; it does not return per-test canned answers or add test-only production
branches.

Tests involving time use a fixed fake clock and advance it explicitly. Do not use
real sleeps, polling loops, timing tolerances, or implicit wall-clock values.
Asynchronous protocol tests wait on the event that proves progress and retain a
bounded scenario timeout only as failure containment.

## Commands

Build test assets before running coverage suites:

```bash
pnpm build:test
```

Focused suites:

```bash
pnpm test:integration:cli
pnpm test:integration:web
pnpm test:integration:worker
pnpm test:integration:platform
pnpm test:agent-daemon
pnpm test:e2e
```

Coverage partitions:

```bash
pnpm test:cli
pnpm test:sdk
pnpm test:integration
pnpm test:e2e
pnpm test:coverage:client
pnpm test:coverage:relay
pnpm test:coverage:hosting
```

Run `pnpm lint`, `pnpm typecheck`, and only the affected suites locally. Do not run
`pnpm ci:check` locally.

## CI

CI installs and builds once per parallel group:

- `client`: CLI and SDK;
- `relay`: protocol, cross-package integration, and product E2E;
- `hosting`: Web, Standalone Worker, and Platform Worker.

The static job runs lint, typecheck, architecture checks, and Knip. Agent-daemon
cases run as independent matrix jobs selected from the Git diff. The required
`check` job only combines results.

Every coverage partition writes an Istanbul map. CI merges maps into
`coverage/lcov.info`, `coverage/coverage-summary.json`, and HTML output. The 100%
target is advisory; failed tests and missing or empty reports are blocking.
Cloudflare uses Istanbul because its runtime does not support the V8 inspector.
Execution in separately bundled Workers or subprocesses is not credited to the
parent process, so coverage cannot prove an end-to-end path by itself.

## Harness constraints

Web integration files own independent Relay, database, DOM, and teardown state and
run in at most four workers. Standalone and Platform Worker suites remain serialized
inside each package because their Cloudflare bindings share process state. The root
hosting command builds Web first, then runs the two Worker suites concurrently.

Architecture rules are executable in `dependency-cruiser.config.cjs`: protocol is
implementation-independent, Relay core is hosting-independent, hosting packages do
not depend on each other, and storage/entity layers do not depend on services or
composition.
