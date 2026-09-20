# Testing Guide

## End-to-end tests as the system control surface

The end-to-end suite is a deliberately small, high-signal control surface for the
product's happy paths. A maintainer should be able to read its executable scenarios
and understand the successful journeys Mobius promises, without first reading
every package. Business rules, variants, and failures belong in integration or
contract tests. The scenario source and its observable assertions are the coverage
claim; a prose inventory of covered behavior is not.

Each end-to-end scenario must prove both of these properties:

1. It enters through the same supported public API, protocol, SDK, or executable
   that a production user invokes and follows the production composition path.
2. It executes the participating production subsystems together, so breaking a
   required subsystem breaks the scenario instead of being hidden by a
   test-specific implementation.

Use real filesystems, subprocesses, sockets, databases, migrations, and local
servers wherever the production path uses them. A test may own their lifecycle
and configuration, but it must not bypass a participating production layer by
calling an internal implementation directly. Stateful fakes are permitted only
for dependencies outside the Mobius product boundary, and only through the same
production port used by the real dependency.

Keep business actions and outcomes visible in the end-to-end file. Shared support
code may hide ports, process startup, credentials, waiting, and cleanup; it must
not hide which public action the user performs, which production entrypoint
receives it, or which result proves the journey. Prefer a few representative
journeys that cross many packages over a catalogue of isolated cases. Variants,
edge cases, and boundary-specific failures belong in integration or contract
tests unless they change a critical journey's observable promise.

Do not add an end-to-end scenario merely because behavior changed. First decide
whether the change alters a critical journey. If it does, extend the existing
representative scenario when that remains readable; add another scenario only
for a distinct journey. If it does not, place the test at the boundary that owns
the behavior.

Coverage and runtime diagnostics are supporting evidence that the scenarios
reach production code, not substitutes for inspecting the executable path.
Coverage percentages alone cannot establish that a production user can complete
the journey, and prose documentation cannot establish either property above.

## Verification and advisory coverage

`pnpm ci:check` is reserved for CI. It runs static checks, builds assets, and executes `pnpm test:coverage`.
Coverage runs CLI, SDK, protocol/cross-package integration, E2E, web integration,
Standalone Worker, and Platform Worker suites, sequentially after assets are built.
The four suites using the root configuration partition its complete test set.
Each suite writes its
own Istanbul map; the maps are merged into `coverage/lcov.info`,
`coverage/coverage-summary.json`, and an HTML report in `coverage/`.

Coverage reports exact covered/total counts for lines, statements, functions, and
branches. The 100% target is advisory: lower coverage does not fail the command.
Test failures and missing or empty reports still fail verification.
Source includes all production `packages/*/src/**/*.{ts,tsx}`,
including UI and hosting adapters and files never imported by tests. Declarations,
tests, and stateful testing fakes are excluded. Code executed only in an external
process or separately bundled browser/Worker is not credited by the parent runner;
its source remains in the denominator until its execution is instrumented.

Worker-pool reports currently cover each hosting package only. Enabling external
coverage for Relay core and protocol causes the Worker runner to fail during
reporting. Those packages remain in the root denominator; their Worker execution
is not yet credited. Cross-runtime collection is therefore not complete.

Istanbul is used consistently because the Cloudflare runtime does not support the
V8 provider's inspector. Do not combine reports from different source revisions.
The command clears its output directory before running and requires each suite's
report before emitting the canonical report.

CI runs one static job and three test groups. The static job installs once and runs
lint, typecheck, and Knip together. Each test group installs and builds once, then
runs related suites sequentially: `client` owns CLI and SDK, `relay` owns integration
and E2E, and `hosting` owns web, Standalone Worker, and Platform Worker. The groups
run in parallel, retaining useful suite isolation without rebuilding the workspace
seven times. Each group saves its Istanbul execution maps as one artifact for 14
days. The required `check` job only combines job results; it does not check out the
repository, install dependencies, or merge advisory coverage again.

Do not run `pnpm ci:check` locally. Run `pnpm lint` and `pnpm typecheck`, then run only
the suites related to the change when needed. CI retains the complete suite membership;
failed tests and missing suite maps remain blocking.

After `pnpm build`, use `pnpm test:cli`, `pnpm test:sdk`,
`pnpm test:integration`, or `pnpm test:e2e` for the corresponding coverage suite.
CLI selects `packages/cli/tests/`; SDK selects `packages/mobius-sdk/tests/`;
E2E selects `e2e/`. Integration owns the remaining root-discovered files,
including protocol contracts and cross-package Runtime integration tests.
Each suite writes a separate coverage directory. The CI test groups expose
`pnpm test:coverage:client`, `pnpm test:coverage:relay`, and
`pnpm test:coverage:hosting` for reproducing the same grouped execution locally.

## Architecture enforcement

`pnpm check:architecture` enforces the dependency rules in
`dependency-cruiser.config.cjs`, including type-only imports:

- `protocol` does not depend on implementation packages.
- Shared Relay core does not depend on either hosting implementation.
- Platform and Standalone implementations do not depend on each other.
- Storage, entity, and infrastructure do not depend on services, HTTP, composition,
  gateways, or Durable Object hosts.

These are concrete information-hiding boundaries from
[Business logic decomposition patterns](https://github.com/taowen/modularization-examples).
Composition owns concrete adapters. Lower-level records and execution contracts
remain with `entity` and `infra`. The parser uses a private TypeScript 6 compiler
API dependency; application compilation remains on TypeScript 7.
Qualitative review considers interface churn, persistent-state exposure, and the
applicability of shared mechanisms rather than adding abstractions based on size.

## Executable Product Specifications

Deliver each behavior change as the smallest path a user can run and observe. Before implementation, state the slice in one sentence:

> After this, a user can ... and see ...

The slice should cross the necessary input, runtime, adapter, and output boundaries. Do not build complete horizontal layers that provide no runnable behavior. Extend the existing working path and implement only what the current slice requires.

Behavior changes start with a failing test at the highest owning boundary before
production code changes. Changes to a critical journey start by changing its
representative end-to-end scenario. Other changes start with an integration or
contract scenario at the boundary that owns the behavior. The scenario must fail
because the promised behavior is absent and pass after the smallest implementation
of that behavior.

BDD scenarios are executable specifications. Every test title uses this form:

```text
Given [observable context], When [an actor performs an action], Then [an observable result occurs]
```

User-path titles describe product behavior in domain language. Protocol and external-boundary titles describe the contract owned by that boundary. Keep fixtures, helpers, framework terminology, internal modules, and implementation details out of titles and in the test body.

Documentation-only changes and mechanical refactors with no behavior change do not need new tests.

## Test Scope

Give each critical user journey one representative end-to-end scenario and each
boundary contract one primary owning test at the boundary that provides the
clearest stable failure. Do not promote every product rule into a separate
end-to-end scenario. Add a narrower test or repeat an invariant at another level
only when it covers a distinct high-impact risk or delivery failure, such as
authorization, destructive side effects, data integrity, protocol compatibility,
cancellation, or resource cleanup.

Do not test repository tooling or scaffolding. This includes CI workflows, lint and formatter configuration, Git hooks, dependency-management configuration, build scripts, and other development-only automation. Verify those concerns by running the tools themselves. Do not test third-party library behavior or add tests solely to increase coverage.

## Required Test Levels

Only write end-to-end tests for representative happy paths. Business logic must be covered by integration tests, while protocols and external boundaries use integration or contract tests. End-to-end tests start at the actual supported public entrypoint and compose the production path behind it; integration and contract tests exercise the production boundary contract. Use production components together with real temporary filesystems, subprocesses, sockets, and local protocol servers where the product path requires them.

Integration tests exercise behavior through user-visible mouse and keyboard interactions. They must not read from, write to, or invoke application stores directly. Test infrastructure may create and destroy the production application around those interactions.
Integration tests bootstrap the entire application; rendering individual React components or views is forbidden.

Prepare state through the cheapest production business operation available at
the tested boundary. Each composition level has one shared journey harness that
owns startup, credentials, and cleanup; tests vary only the business state they
need. Direct persistence setup is reserved for storage and migration boundaries,
or for state owned by an upstream component outside the test, and must remain
explicit.

A lower-level test is not acceptance if the supported user path could break while the test still passes. Boundary tests may support a slice, but they cannot replace its user-visible acceptance scenario.

Likewise, a test is not end-to-end when it invokes an internal service or helper
in place of a public step that production users must traverse. Starting a
production application with test-owned configuration is allowed; replacing one
of its internal layers with test orchestration is not.

Unit tests are prohibited by default. The default Vitest configuration only
discovers `*.contract.test.ts`, `*.integration.test.ts`, and
`*.e2e.test.ts`. Renaming an isolated helper or class test does not make it a
boundary test: move the assertion to the owning protocol, runtime, or product
entrypoint, or remove it when a stronger scenario already owns the behavior.

## CLI Integration Tests

Run the CLI boundary suite from the repository root:

```bash
pnpm test:integration:cli
```

The suite exercises the production CLI, local filesystem, SQLite, Unix socket,
subprocess, process-tree, Agent, and Relay boundaries. CI runs it on Linux so a
CLI change cannot pass the release gate solely on macOS behavior. Linux process
cleanup reads procfs directly and falls back to a compatible fixed system `ps`;
managed archives accept the standard `/usr/bin` and `/bin` tool locations used
by glibc and musl distributions.

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
WebSocket tests. `pnpm ci:check` includes these suites with coverage;
`pnpm test:integration:hosting` remains available for focused verification without the
aggregate coverage report.

The root `pnpm test:integration:hosting` command first builds and tests Web, then runs
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
WebSocket boundaries. Its integration scenarios own the separation of Platform
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

Coverage identifies untested code but does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. Cover representative happy paths with end-to-end tests, business logic with integration tests, and protocol or external boundaries with integration or contract tests.
