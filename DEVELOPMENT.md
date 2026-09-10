# Development Guide

## Pairing tenant ownership

Pairing creation uses an existing tenant supplied by the host's `PairingTenantResolver`.
Mobius does not generate a tenant per pairing. The resolver must derive ownership
from verified identity or trusted deployment configuration, never a client-supplied
tenant ID. Embedding applications supply this port to `createRelayDependencies`,
which assembles the pairing service.

Standalone Workers configure `MOBIUS_TENANT_ID`; the supplied Wrangler profiles
explicitly use `standalone`. Set it to the deployment's tenant ID when deploying.
The embedded `Pair` component requires `getPairingToken(signal)`. Authenticated
hosts return their identity token; the standalone page explicitly returns `null`
and relies on the server's configured tenant.
Missing or invalid configuration rejects pairing creation with
`pairing_tenant_unavailable` (503). Health and existing credential-based operations
do not require creating a new tenant.

Bootstrap pairing creates a project, channel, runtime, and persistent project-owner
credential. An authenticated project owner can add runtimes to that project;
additional runtime pairing preserves the project and owner credential. Revoking
a runtime does not revoke project ownership. Pairing and session responses carry the resolved tenant ID. Tenant
quotas now aggregate new projects assigned to the same tenant. Previously issued
credentials and stored sessions keep their original ownership; this change does
not reassign existing data.

## Local Execution Boundary

Mobius connects remote clients to agent harnesses running on a user's machine. The process that performs a local side effect is therefore the final and only trusted enforcement point.

Every operation that can affect the local machine must follow the same pipeline:

```text
untrusted input
  -> schema validation
  -> normalization and target resolution
  -> capability and target authorization
  -> execution
  -> audit event
```

Define external boundary contracts with Zod schemas and derive their TypeScript types with `z.infer` instead of duplicating interfaces. Parse incoming values from `unknown`; type assertions are never validation.

Keep validation and authorization distinct. Schema validation establishes that a request is well formed; authorization establishes that the active session may perform that specific operation. Neither result implies the other.

For values whose meaning can change after resolution, check both forms. Examples include symbolic links, relative paths, redirects, hostnames, executable lookup, and command arguments. Authorization must be repeated at the local execution boundary immediately before the side effect.

## Make Illegal States Unrepresentable

Use an abstract state base class with one concrete class per lifecycle state:

```ts
abstract class SessionState {
  abstract readonly kind: string;
}

class ConnectingSessionState extends SessionState {
  readonly kind = "connecting";
}

class ActiveSessionState extends SessionState {
  readonly kind = "active";
  readonly capabilities: ReadonlySet<Capability>;
  readonly sessionId: string;

  constructor(sessionId: string, capabilities: ReadonlySet<Capability>) {
    super();
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }
}

class ClosedSessionState extends SessionState {
  readonly kind = "closed";
  readonly reason: CloseReason;

  constructor(reason: CloseReason) {
    super();
    this.reason = reason;
  }
}
```

Do not model the same concept as unrelated optional fields:

```ts
// Invalid combinations are possible: active without a session ID, or closed with capabilities.
interface SessionState {
  readonly active?: boolean;
  readonly sessionId?: string;
  readonly capabilities?: ReadonlySet<Capability>;
  readonly closeReason?: CloseReason;
}
```

State transitions should accept only valid source-state classes and return a complete destination state. Consumers branch with `instanceof` and must reject unknown state classes explicitly.

Use optional properties only when absence is meaningful within the same state. Use `null` only when an explicit empty value is part of the domain. Reserve `Partial<T>` for update payloads, never for lifecycle or protocol states.

## Protocol, Domain, and Port Contracts

Treat protocol messages, domain values, and ports as contracts. Their properties must be `readonly` so consumers cannot mutate shared state behind the owner's back.

Declare callbacks and port operations with function property syntax:

```ts
interface HarnessPort {
  readonly connect: (
    request: ConnectRequest,
    signal: AbortSignal,
  ) => Promise<Session>;
}
```

Do not use method syntax for these contracts. TypeScript intentionally excludes method parameter positions from `strictFunctionTypes`, while function properties receive the stricter variance check.

This rule applies to protocol, domain, and port contracts. It does not require every short-lived local object or mutable implementation detail to be immutable.

## Function Design

Function signatures must express intent precisely. Prefer purpose-specific functions and domain types over boolean mode flags or broad parameter objects. A function must do only what its name promises.

## Cancellation, Timeouts, and Resource Ownership

Every asynchronous operation that waits on an external system accepts an `AbortSignal`. A finite operation applies an explicit timeout appropriate to its boundary; a long-lived stream applies connection and liveness deadlines so no individual wait is unbounded. Callers propagate the same cancellation intent through runtime and adapter layers instead of creating disconnected cancellation trees.

Cancellation is a distinct outcome. Do not convert it into a generic network or runtime failure, and do not retry it. A retry policy must be bounded, cancellable, and restricted to failures and operations that are safe to repeat. Never retry an operation after its side effects are known to have occurred or when the outcome is indeterminate unless the operation has an explicit idempotency contract.

The code that acquires a resource owns its release unless ownership is explicitly transferred in the type contract. Connections, streams, subprocesses, locks, timers, subscriptions, and concurrency slots must be released on success, failure, and cancellation. Prefer `try`/`finally` or a scoped helper that makes cleanup structurally unavoidable.

## Typed Error Contracts

Errors crossing subsystem, port, or protocol boundaries require a stable machine-readable code and a safe human-readable message. Model outcomes that require different handling separately, including cancellation, timeout, retryable failure, and terminal failure.

Consumers must branch on the error type or code, never by matching message text. Human-readable messages may change without breaking behavior.

Do not catch, ignore, or replace a failure unless the current boundary can fully handle it. Otherwise, propagate it or translate it once into the owning boundary's error contract, preserving the original failure as the cause.

Do not expose secrets, credentials, raw remote payloads, or unnecessary local paths in protocol error messages. Unexpected exceptions must be normalized at the boundary where they leave the process or subsystem.

## Abstraction Discipline

Start with the simplest direct implementation of the current behavior. Keep control flow local and linear when that makes the operation easier to read.

Introduce an abstraction only when at least one of these conditions is true:

- It isolates a real external boundary, such as a transport, harness, clock, or persistent store.
- A second real use case requires interchangeable behavior.
- Current duplication has been demonstrated and the abstraction makes the code simpler.

Do not create layers, factories, generic frameworks, configuration switches, or extension points for hypothetical future requirements. Remove unused indirection. Extract details when they obscure the caller's main control flow, but keep them inline when they are the function's primary job.

## Defensive Code

After the local execution boundary has converted untrusted input into a trusted domain type, rely on that type and its established contract instead of repeating checks or adding fallbacks for states the contract excludes. Apply the boundary pipeline again when new untrusted data enters or resolution changes a value's security meaning.

Add defensive branches, compatibility paths, or fallback behavior only for a documented external failure mode, security requirement, or observed production risk. An invariant violation must fail visibly instead of being converted into an empty value, default result, or alternate behavior.

## Comments

Code should be self-explanatory through names, types, and structure. Implementation comments explain constraints, tradeoffs, compatibility requirements, or why an apparently simpler approach is unsafe; they do not merely restate what the code does. Public contract documentation describes purpose, supported usage, and observable behavior.

## Publishing the CLI

The `@moxt-ai/mobius` package is published by `.github/workflows/publish-cli.yml`
when the version in `packages/cli/package.json` changes on `main`. The workflow
compares the package version before and after the push, skips publication when
the version is unchanged, and runs the full repository check before publishing
to npm.

Before the first automated release, configure a GitHub Actions trusted publisher
for `@moxt-ai/mobius` in npm with these values:

- Organization or user: `moxt-ai`
- Repository: `mobius`
- Workflow filename: `publish-cli.yml`
- Environment: leave unset
- Allowed actions: allow direct `npm publish`

After trusted publishing is configured, merge a CLI version change to `main` to
publish it. No release tag is required. The workflow uses npm trusted publishing,
so it does not require an `NPM_TOKEN` repository secret.

## Publishing the SDK

`.github/workflows/publish-sdk.yml` publishes `@moxt-ai/mobius-sdk` when the
version in `packages/web-sdk/package.json` changes on `main`, following the CLI
release policy. It runs `pnpm check`, packs the protocol and SDK with pnpm, and
prints an npm publication dry run before publishing. pnpm packing applies
`publishConfig` and replaces workspace dependencies with registry versions.

The SDK depends on `@moxt-ai/mobius-protocol`. The workflow publishes the local
protocol version first if npm returns 404 for that version; an existing version
is reused. Bump the protocol version alongside the SDK when protocol changes
must ship. Registry failures other than 404 stop the release.

Configure npm trusted publishing for **both** packages with organization
`moxt-ai`, repository `mobius`, workflow `publish-sdk.yml`, no environment, and
direct `npm publish` enabled. For a package that does not yet exist, bootstrap
its first publication with an authorized npm account, then configure its trusted
publisher. No npm token is committed or required by this workflow.

To inspect the exact release artifacts locally without publishing:

```bash
mkdir -p /path/to/release-preview
pnpm --dir packages/protocol pack --out /path/to/release-preview/mobius-protocol.tgz
pnpm --dir packages/web-sdk pack --out /path/to/release-preview/mobius-sdk.tgz
npm publish /path/to/release-preview/mobius-protocol.tgz --access public --dry-run
npm publish /path/to/release-preview/mobius-sdk.tgz --access public --dry-run
```

Adding the workflow alone does not release a version; merge an SDK version bump
after the npm publishers are configured.

## Adding a Local Agent

See [Local Agent Integration](./docs/local-agent-integration.md) for the module
boundaries, trust constraints, registration point, and verification checklist.
