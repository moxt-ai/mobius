# Testing Guide

## Vertical Slices

Deliver each behavior change as the smallest end-to-end path a user can run and observe. Before implementation, state the slice in one sentence:

> After this, a user can ... and see ...

The slice should cross the necessary input, runtime, adapter, and output boundaries. Do not build complete horizontal layers that provide no runnable behavior. Extend the existing working path and implement only what the current slice requires.

A behavior change needs an acceptance test at the first supported boundary that can prove the promised result. Documentation-only changes and mechanical refactors with no behavior change do not need new tests.

## Test Behavior and Owned Boundaries

Assert observable contracts, including returned results, emitted events, protocol messages, state transitions, filesystem effects, process exit status, and typed errors.

Do not assert private helper calls, internal loop shape, incidental ordering, or other implementation details. A refactor that preserves the contract should not break the test.

Place each contract test at the boundary that owns the risk:

- User-entrypoint tests own complete user-visible workflows.
- Protocol and adapter tests own serialization, compatibility, timeouts, cancellation, and upstream failures.
- Domain tests own state transitions and policy decisions.
- Architecture tests own dependency directions and single-owner invariants.

Use real temporary filesystems, subprocesses, sockets, and local protocol servers when practical. Use fakes at external harness or provider boundaries to produce deterministic success, failure, timeout, cancellation, and disconnect behavior. Do not add production-only hooks for tests.

For an operation that owns resources, test observable cleanup after success, failure, timeout, and cancellation when those outcomes are reachable. Retry tests must prove the attempt limit, cancellation during backoff, and the rule that unsafe or indeterminate operations are not retried. Error-contract tests assert stable codes and sanitized boundary messages, not incidental infrastructure wording.

Coverage identifies untested code; it does not decide which tests to write. Do not create impossible typed states or duplicate tests merely to increase coverage. If a branch is unreachable under current invariants, remove or simplify it. If it protects a real runtime boundary, give that boundary an explicit behavioral or invariant test.
