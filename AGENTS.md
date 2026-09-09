# Engineering Rules

These rules apply to the entire repository. See [DEVELOPMENT.md](./DEVELOPMENT.md) for implementation guidance and [TESTING.md](./TESTING.md) for delivery and testing guidance.

## Trust Boundary

The local execution boundary is the only authority allowed to approve local side effects.

- Treat every value received from a remote client, transport, agent harness, model, configuration file, or persisted session as untrusted input.
- Process untrusted input in this order: decode as `unknown`, validate its schema, normalize and resolve security-sensitive targets, authorize the requested capability and resolved target, execute, then record an audit event.
- Validate both the requested representation and the resolved representation of paths, URLs, commands, and other security-sensitive targets.
- Never let a remote assertion, prior validation result, or user-interface approval bypass authorization at the execution boundary.

## State Modeling

Make illegal states unrepresentable.

- Represent protocol and lifecycle states with discriminated unions, not combinations of optional fields or booleans.
- Give each variant exactly the data that is valid in that state, using `readonly` properties for state values.
- Handle state variants exhaustively so a new variant causes a compile-time failure at every incomplete decision point.
- Express state changes through explicit transition functions. Do not mutate fields into a different state.
- Do not use type assertions, `Partial`, or non-null assertions to bypass state invariants.

## Contracts

- Use `readonly` properties for protocol messages, domain values, and port interfaces.
- Declare callbacks and port operations as function properties, such as `readonly send: (message: Message) => Promise<void>`, so `strictFunctionTypes` checks their parameter variance.

## Async Operations

- Every asynchronous operation that waits on an external system must accept cancellation. Finite operations need a timeout; long-lived streams need connection and liveness deadlines.
- Propagate cancellation through every layer. Do not catch, translate, or retry cancellation as an ordinary failure.
- Make resource ownership explicit. The code that acquires a connection, stream, process, lock, timer, or concurrency slot must release it on success, failure, and cancellation.
- Keep retries bounded, cancellable, and limited to operations that are safe to repeat.

## Errors

- Failures that cross a subsystem, port, or protocol boundary must use a typed error contract with a stable machine-readable code.
- Branch on error codes or types, never on human-readable message text.
- Preserve the original cause when translating an error, and expose only sanitized messages across trust boundaries.
- Keep cancellation, timeout, retryable, and terminal failures distinct.

## Delivery

- Deliver behavior as the smallest user-runnable vertical slice through input, logic, and observable output.
- Describe each behavior slice as: "After this, a user can ... and see ..." If that sentence is not concrete, narrow the slice.
- Start every behavior change with a failing Given-When-Then acceptance scenario that proves the user-visible slice through the first supported product boundary that can observe it. Treat the scenario as executable product documentation, and implement only what it requires.
- Do not add unit tests by default. Add one only when the user explicitly requests unit-level coverage or a repository maintainer documents an exception for an invariant that cannot be exercised through a supported product boundary.
- Critical user paths must use end-to-end tests. Protocols and external boundaries must use integration or contract tests. Do not test CI, linting, Git hooks, build tooling, dependency configuration, or other repository scaffolding.
- Except for deterministic fake timers, mocks, spies, stubs, monkey patching, module replacement, and canned request interceptors are prohibited. If a real external dependency cannot be used safely or deterministically, inject a stateful fake through its production port.
- Tests involving time must use fake timers with an explicit system time. Every test is prohibited from using real sleeps, wall-clock time, polling delays, or timing tolerances.
- Assert externally observable results, not private control flow, collaborator calls, or implementation details.
- Documentation-only and mechanical refactoring changes do not require new tests when behavior is unchanged.

## Abstraction

- Storage must not import any upper layer: services, HTTP/routes, composition/DI, application gateways, or platform adapters. This includes type-only imports and re-exports through package barrels. Shared values and records belong in `entity`; execution contracts belong in `infra`. Those lower-level modules must not depend on upper layers either.

- Prefer direct, local, linear code.
- Add an abstraction only for a real external boundary, a second real use case, or proven duplication.
- Do not add speculative extension points, generic frameworks, or unused layers.

## Verification

Run `pnpm check` before submitting a pull request.
