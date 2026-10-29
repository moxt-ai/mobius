---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Engineering Rules

These rules apply to the entire repository. You must read [CONTRIBUTING.md](docs/CONTRIBUTING.md) before opening an issue or pull request; it defines contribution and implementation requirements. See [TESTING.md](docs/TESTING.md) for delivery and testing guidance. Every code review must also follow [CODE_REVIEW.md](docs/CODE_REVIEW.md).

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

## Compatibility is mandatory by default

Morty Web, SDK clients, deployed services, local Mobius Runtimes, and stored data
upgrade independently. Preserve existing external contracts and behavior in both
directions: new clients with old servers/Runtimes, and old clients with new
servers/Runtimes. A successful all-new deployment does not establish compatibility.

- Only an explicit instruction from the human user or maintainer to make a
  particular breaking change authorizes incompatibility. A request to refactor,
  simplify, upgrade, bump a major version, or remove apparently unused code does
  not authorize it. AI agents must not invent an end-of-support decision.
- When a breaking change is explicitly required, limit it to the authorized
  contract and record the instruction, affected peers/data, rollout, and recovery
  consequences in the PR. Preserve every unaffected contract. Do not request the
  same authorization again when it is already explicit.
- Preserve accepted request formats, response meanings, defaults, error codes,
  and retry/idempotency guarantees. New fields, enum values, or message kinds are
  not automatically compatible: check the actual released readers and callers.
  Silently ignoring an unknown operation is not successful execution.
- Enable a new operation or representation only after establishing support for
  that contract at the relevant protocol boundary. Define the behavior of peers
  that omit the new capability; they must retain the existing supported behavior.
  Agent/ACP capabilities do not establish Runtime/relay protocol support.
- Deploy compatible receivers before enabling new senders. Keep the old path
  usable during independent upgrades and supported rollback. Do not require a
  browser refresh, Runtime upgrade, or synchronized deployment to preserve an
  existing supported operation.
- Keep compatibility decisions in the owning protocol adapter, not scattered
  across views or callers. Prefer negotiated protocol support to application
  release-number special cases. Reuse authoritative connection information;
  do not add duplicate persistent capability state.
- Do not switch protocol representations or generate a new operation identity
  after an ambiguous failure to guess whether a peer supports an operation.
  Preserve the request's meaning, identity, and existing recovery guarantees.
- For a changed contract, provide focused integration/contract evidence for both
  mixed-version directions using released peers or independently retained old
  contracts. Do not replace the old baseline with the new implementation or
  weaken validation, authorization, or size limits to make compatibility pass.
  Follow [CODE_REVIEW.md](docs/CODE_REVIEW.md) before declaring the change ready.

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

## Documentation changes

- Every Markdown file except `SKILL.md` must include `metadata.change-policy` in its
  YAML frontmatter, stating that changes require a separate documentation-only PR
  for review and approval. Skill entrypoints retain their existing frontmatter.
- Change Markdown files in documentation-only pull requests, separate from code,
  configuration, dependencies, and submodule updates. This includes additions,
  deletions, and renames of `.md`, `.markdown`, and `.mdx` files.
- Review by `taowen-paraflow` is recommended for Markdown changes, not required.
- Documentation defines product intent, constraints, and operational guidance.
  Do not maintain implementation maps, source-file inventories, or copies of
  protocol fields and state machines in Markdown. Make source organization,
  names, types, and focused inline comments explain the implementation.
- When changing an existing documented constraint, propose that change separately
  before implementing behavior that depends on it.

## Delivery

- Deliver behavior as the smallest user-runnable vertical slice through input, logic, and observable output.
- Any change to distributable CLI behavior under `packages/cli/src/` must increment the version in `packages/cli/package.json`; use a patch increment unless the release explicitly requires a minor or major version.
- Any change to `packages/protocol` or `packages/mobius-sdk` must increment the corresponding package version so the npm publish workflow releases it. Package versions follow the dependency chain `packages/protocol` -> `packages/mobius-sdk` -> `packages/cli`: incrementing the Protocol version requires incrementing the SDK and CLI versions in the same pull request, and incrementing the SDK version requires incrementing the CLI version.
- Describe each behavior slice as: "After this, a user can ... and see ..." If that sentence is not concrete, narrow the slice.
- Start every behavior change with a failing Given-When-Then scenario at the highest boundary that owns it. Change a representative end-to-end scenario only when the behavior changes a critical user journey; otherwise use the owning integration or contract boundary.
- Do not add unit tests by default. Add one only when the user explicitly requests unit-level coverage or a repository maintainer documents an exception for an invariant that cannot be exercised through a supported product boundary.
- Only write end-to-end tests for happy paths. Business logic must be covered by integration tests, while protocols, variants, and external boundaries use integration or contract tests. End-to-end scenarios must enter through production user entrypoints and compose the participating production subsystems; test-only orchestration must not bypass an internal product layer. Do not test CI, linting, Git hooks, build tooling, dependency configuration, or other repository scaffolding.
- Web application integration tests enter through navigation and visible controls, bootstrap the complete application, and must not access stores directly or render isolated views. Prefer accessible roles, names, labels, and visible text; use shared `data-testid.ts` constants when no stable semantic selector exists.
- CLI and daemon integration tests enter through CLI commands or the public daemon protocol. SDK tests enter through its public API against a peer at the production transport boundary. Worker integration tests enter through production HTTP, WebSocket, Durable Object, queue, or storage boundaries. These non-UI suites do not require a browser or DOM.
- Test boundaries follow `docs/TESTING.md`: Web / Chat tests keep product services and transports real and replace the daemon with the shared stateful fake daemon. CLI fault scenarios may use controlled ACP executables behind the production daemon. Separate compatibility tests use each real Agent executable and production adapter. Controlled ACP peers cannot establish Agent compatibility.
- Except for deterministic fake timers, mocks, spies, stubs, monkey patching, module replacement, and canned request interceptors are prohibited. If a real external dependency cannot be used safely or deterministically, inject a stateful fake through its production port.
- Tests involving time must use fake timers with an explicit system time. Every test is prohibited from using real sleeps, wall-clock time, polling delays, or timing tolerances.
- Assert externally observable results, not private control flow, collaborator calls, or implementation details.
- Documentation-only and mechanical refactoring changes do not require new tests when behavior is unchanged.

## Abstraction

### Server layers

Server behavior flows inward through `http/do -> service -> storage -> database`. HTTP routes and Durable Objects translate and orchestrate requests, services own domain validation and transformations, storage owns persistence through the authoritative Drizzle schema and ORM query builder, and gateways communicate our services with external services. Do not skip layers or move domain/protocol decisions into storage. Do not issue raw SQL strings where the ORM can express the query.

- Drizzle schema modules are the authoritative typed description of current SQLite tables. Keep one table per file under the owning package's `src/schema/<target>` (for example, `schema/d1`, `schema/project-do`, or `schema/runtime-connection-do`), preserve SQL names, indexes, defaults, enum typing, and check constraints, and do not declare foreign-key relations. Never place Durable Object tables in `schema/d1`, and never use one target's schema as the implicit schema for another target. Storage adapters use Drizzle's schema-backed query builder; do not use tagged or raw SQL to imitate ORM queries. Historical migrations remain the deployment mechanism.
- Keep Drizzle configuration in the repository-level `drizzle/` directory. Generate each target's migrations into `migrations/<target>` with the repository's pinned Drizzle CLI; do not hand-write migration SQL.
- Durable Object runtime code must execute committed `.sql` migrations generated for its target; do not embed application-table DDL or migration SQL in TypeScript. Prefer importing the SQL directly with `?raw`. Where the build pipeline cannot import SQL, use a committed code-generation script that copies the generated SQL verbatim into a gitignored module and keep `.sql` as the source of truth.
- Storage must not import any upper layer: services, HTTP/routes, composition/DI, application gateways, or platform adapters. This includes type-only imports and re-exports through package barrels. Shared values and records belong in `entity`; execution contracts belong in `infra`. Those lower-level modules must not depend on upper layers either.

- Prefer direct, local, linear code.
- Add an abstraction only for a real external boundary, a second real use case, or proven duplication.
- Do not add speculative extension points, generic frameworks, or unused layers.

## Verification

For routine local development, run `pnpm lint`, `pnpm typecheck`, and only the
related test cases. Use `pnpm ci:check` locally only when diagnosing the combined
CI validation.
