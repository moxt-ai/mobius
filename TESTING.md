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

Assert observable contracts, including returned results, emitted events, protocol messages, state transitions, filesystem effects, process exit status, and typed errors.

Do not write isolated tests for private helpers, internal control flow, incidental ordering, or implementation details. Do not assert that an internal collaborator was called. A refactor that preserves the product contract should not break the test.

Except for the deterministic fake timers required below, mocks are prohibited. Do not use mock functions, mocking frameworks, spies, stubs, monkey patching, module replacement, or canned request interceptors.

When a real external harness or provider cannot be used safely or deterministically, a stateful fake injected through the production port is the only permitted substitute. Keep the fake at that external boundary, make it implement the real contract instead of returning per-test canned answers, and explain why the real dependency cannot be used. Do not add test-only branches or hooks to production code.

## Deterministic Time

Tests involving time must use fake timers with an explicit fixed system time and restore timer state during cleanup. Advance the fake clock explicitly to exercise deadlines, retries, heartbeats, and cancellation.

Do not use real sleeps, polling delays, implicit `Date.now()` values, or timing tolerances. Time-sensitive production code must accept a clock or timer dependency at its real boundary so tests can inject deterministic time. Do not replace time with any other mocking mechanism.

For an operation that owns resources, test observable cleanup after success, failure, timeout, and cancellation when those outcomes are reachable. Retry tests must prove the attempt limit, cancellation during backoff, and the rule that unsafe or indeterminate operations are not retried. Error-contract tests assert stable codes and sanitized boundary messages, not incidental infrastructure wording.

Coverage identifies untested code but does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. Cover critical user paths with end-to-end tests and protocol or external boundaries with integration or contract tests.
