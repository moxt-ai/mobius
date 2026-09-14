# Testing Guide

## Executable Product Specifications

Deliver each behavior change as the smallest end-to-end path a user can run and observe. Before implementation, state the slice in one sentence:

> After this, a user can ... and see ...

The slice should cross the necessary input, runtime, adapter, and output boundaries. Do not build complete horizontal layers that provide no runnable behavior. Extend the existing working path and implement only what the current slice requires.

Behavior changes start with a failing BDD acceptance scenario before production code changes. The scenario must fail because the promised behavior is absent, prove the slice through the first supported product boundary that can observe it, and pass after the smallest implementation of that behavior. Add narrower scenarios afterward only for distinct boundary-owned risks.

BDD scenarios are executable product specifications and the living documentation of supported behavior. Every test title uses this form:

```text
Given [observable context], When [an actor performs an action], Then [an observable result occurs]
```

User-path titles describe product behavior in domain language. Protocol and external-boundary titles describe the contract owned by that boundary. Keep fixtures, helpers, framework terminology, internal modules, and implementation details out of titles and in the test body.

Documentation-only changes and mechanical refactors with no behavior change do not need new tests.

## Test Scope

Give each supported product promise one primary acceptance scenario and each boundary contract one primary owning test at the boundary that provides the clearest stable failure. Add a narrower test or repeat an invariant at another level only when it covers a distinct high-impact risk or delivery failure, such as authorization, destructive side effects, data integrity, protocol compatibility, cancellation, or resource cleanup.

Do not test repository tooling or scaffolding. This includes CI workflows, lint and formatter configuration, Git hooks, dependency-management configuration, build scripts, and other development-only automation. Verify those concerns by running the tools themselves. Do not test third-party library behavior or add tests solely to increase coverage.

## Required Test Levels

Critical user paths must use end-to-end tests. Protocols and external boundaries must use integration or contract tests. End-to-end tests exercise supported public entrypoints; integration and contract tests exercise the production boundary contract. Use production components together with real temporary filesystems, subprocesses, sockets, and local protocol servers where the product path requires them.

A lower-level test is not acceptance if the supported user path could break while the test still passes. Boundary tests may support a slice, but they cannot replace its user-visible acceptance scenario.

Unit tests are prohibited by default. The default Vitest configuration only
discovers `*.contract.test.ts`, `*.integration.test.ts`, and
`*.e2e.test.ts`. Renaming an isolated helper or class test does not make it a
boundary test: move the assertion to the owning protocol, runtime, or product
entrypoint, or remove it when a stronger scenario already owns the behavior.

## Web Integration Tests

### Platform page colors (manual browser scenario)

Given a visitor opening Platform with either a light or dark browser preference,
When the initial document is displayed and the application finishes loading,
Then the page background stays `#f4f6f4`, the default text is `#17221d`, and
native controls use a light color scheme. Verify the initial document while
JavaScript is disabled, then enable JavaScript and check both the signed-out
page and signed-in dashboard. The browser theme color should also be `#f4f6f4`.

Run the Web boundary suite from the repository root:

```bash
pnpm test:integration:web
```

The dedicated configuration at `packages/web/vitest.integration.config.ts`
mounts the complete `App` in Happy DOM. It does not use Vitest Browser Mode or
launch a real browser. The suite uses Wrangler's programmatic Cloudflare test
harness to start the production Worker on an isolated random local port, apply
the D1 migrations, and exercise the production HTTP and WebSocket paths with a
stateful local daemon. It does not spawn the Wrangler CLI, replace `fetch`,
intercept requests, or patch production modules.

Web integration files run in at most four Vitest workers. Each file owns its
Relay harness, database, browser environment, and teardown; scenarios within a
file remain sequential. Keep this isolation when adding files so concurrent
execution does not share ports, credentials, or mutable browser state.

The daemon is a stateful protocol peer at the external local-Agent boundary,
so CI can drive deterministic Agent states without provider credentials or an
interactive third-party process. It exchanges real Mobius messages over the
real Relay WebSocket instead of returning per-test canned responses.

Web scenarios belong in `packages/web/test/**/*.integration.test.tsx`. Assert
through accessible DOM output and user events. Do not call Zustand actions,
render isolated components, or import private presentation and form helpers in
tests. Browser-specific layout and rendering remain manual verification unless
a future behavior explicitly requires a real-browser end-to-end boundary.

## Cloudflare Worker Integration Tests

Run the relay's Worker-boundary suite from the repository root:

```bash
pnpm test:integration:worker
```

The dedicated configuration at `packages/relay-cloudflare-standalone/vitest.config.ts`
loads the package's `wrangler.jsonc`, starts a local Workers runtime, and applies
every migration in `packages/relay-core/migrations/d1` before the test
file runs. The suite uses isolated local D1 and Durable Object bindings; it
does not require Cloudflare credentials and never connects to production
resources.

Worker integration scenarios belong in
`packages/relay-cloudflare-standalone/test/**/*.integration.test.ts`. Keep the
`--max-workers=1 --no-isolate` flags in the package command: the Workers Vitest
integration currently requires shared, serialized storage for Durable Object
WebSocket tests. Run `pnpm test:integration` in addition to `pnpm check` before
delivery; it runs the Web, Standalone Worker, and Platform Worker integration
suites.

The root `pnpm test:integration` command first builds and tests Web, then runs
at most two independent Cloudflare package suites concurrently. Web must finish
its build before the other harnesses read its assets; overlapping those steps
would race Vite's cleanup of `packages/web/dist`. Each Cloudflare suite retains
`--max-workers=1 --no-isolate` for its shared storage.
The package-specific commands above remain available to investigate a single
boundary without running the other suites.

## Cloudflare Platform Integration Tests

Run the independent Platform Worker-boundary suite from the repository root:

```bash
pnpm test:integration:platform
```

The Platform Vitest configuration mounts the production Platform entry, applies
both the shared Project D1 migration stream and the independent Platform control
plane migration stream, and uses real local D1, Durable Object, HTTP, SSE, and
WebSocket boundaries. Its acceptance scenarios own the separation of Platform
and Standalone, OIDC developer provisioning, AppCredential scope and rotation,
multi-Project and multi-Runtime behavior, fixed browser Session routes, exact
origin handling, cursor recovery, and live credential revocation.

Assert observable contracts, including returned results, emitted events, protocol messages, state transitions, filesystem effects, process exit status, and typed errors.

Do not write isolated tests for private helpers, internal control flow, incidental ordering, or implementation details. Do not assert that an internal collaborator was called. A refactor that preserves the product contract should not break the test.

Except for the deterministic fake timers required below, mocks are prohibited. Do not use mock functions, mocking frameworks, spies, stubs, monkey patching, module replacement, or canned request interceptors.

When a real external harness or provider cannot be used safely or deterministically, a stateful fake injected through the production port is the only permitted substitute. Keep the fake at that external boundary, make it implement the real contract instead of returning per-test canned answers, and explain why the real dependency cannot be used. Do not add test-only branches or hooks to production code.

## Deterministic Time

Tests involving time must use fake timers with an explicit fixed system time and restore timer state during cleanup. Advance the fake clock explicitly to exercise deadlines, retries, heartbeats, and cancellation.

Do not use real sleeps, polling delays, implicit `Date.now()` values, or timing tolerances. Time-sensitive production code must accept a clock or timer dependency at its real boundary so tests can inject deterministic time. Do not replace time with any other mocking mechanism.

For an operation that owns resources, test observable cleanup after success, failure, timeout, and cancellation when those outcomes are reachable. Retry tests must prove the attempt limit, cancellation during backoff, and the rule that unsafe or indeterminate operations are not retried. Error-contract tests assert stable codes and sanitized boundary messages, not incidental infrastructure wording.

Coverage identifies untested code but does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. Cover critical user paths with end-to-end tests and protocol or external boundaries with integration or contract tests.
