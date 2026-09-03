# Testing Guide

## Vertical Slices

Deliver each behavior change as the smallest end-to-end path a user can run and observe. Before implementation, state the slice in one sentence:

> After this, a user can ... and see ...

The slice should cross the necessary input, runtime, adapter, and output boundaries. Do not build complete horizontal layers that provide no runnable behavior. Extend the existing working path and implement only what the current slice requires.

A behavior change needs an acceptance test at the first supported boundary that can prove the promised result. Documentation-only changes and mechanical refactors with no behavior change do not need new tests.

## Test Scope

Tests exist to protect critical product behavior. Add a test only when it covers a primary user workflow or a high-impact product boundary, such as authorization, destructive side effects, data integrity, protocol compatibility, cancellation, or resource cleanup.

Do not test repository tooling or scaffolding. This includes CI workflows, lint and formatter configuration, Git hooks, dependency-management configuration, build scripts, and other development-only automation. Verify those concerns by running the tools themselves. Do not test third-party library behavior or add tests solely to increase coverage.

## End-to-End Tests

Every product test must exercise a supported public entrypoint end to end and assert an externally observable result. Use production components together with real temporary filesystems, subprocesses, sockets, and local protocol servers where the product path requires them.

Assert observable contracts, including returned results, emitted events, protocol messages, state transitions, filesystem effects, process exit status, and typed errors.

Do not write isolated tests for private helpers, internal control flow, incidental ordering, or implementation details. Do not assert that an internal collaborator was called. A refactor that preserves the product contract should not break the test.

Mocks are prohibited. Do not use mock functions, mocking frameworks, spies, stubs, monkey patching, module replacement, or canned request interceptors.

When a real external harness or provider cannot be used safely or deterministically, a stateful fake injected through the production port is the only permitted substitute. Keep the fake at that external boundary, make it implement the real contract instead of returning per-test canned answers, and explain why the real dependency cannot be used. Do not add test-only branches or hooks to production code.

## Deterministic Time

Tests must never observe or wait for real wall-clock time. Every test must run with fake timers installed and an explicit fixed system time, then restore timer state during cleanup. Advance the fake clock explicitly to exercise deadlines, retries, heartbeats, and cancellation.

Do not use real sleeps, polling delays, implicit `Date.now()` values, or timing tolerances. Time-sensitive production code must accept a clock or timer dependency at its real boundary so an end-to-end test can inject deterministic time. Do not replace time with any other mocking mechanism.

For an operation that owns resources, test observable cleanup after success, failure, timeout, and cancellation when those outcomes are reachable. Retry tests must prove the attempt limit, cancellation during backoff, and the rule that unsafe or indeterminate operations are not retried. Error-contract tests assert stable codes and sanitized boundary messages, not incidental infrastructure wording.

Coverage is reporting-only and must not fail CI. It identifies untested code but does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. If it protects a critical product path, exercise it through the end-to-end workflow that owns the behavior.
