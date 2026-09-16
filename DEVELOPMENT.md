# Development Guide

## Repository checks

Run `pnpm check` with `VITE_CLERK_PUBLISHABLE_KEY` set for the Platform build.
For local build-only verification, use the same fixture as CI:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k pnpm check
```

Lint (including architecture), typechecking, and Knip run concurrently through
pnpm's script runner. Builds then finish before the complete coverage suites run,
so browser assets cannot be removed while integration harnesses read them.
The explicit `mobius-workspace` filter selects the root static checks.
Staged pre-commit lint runs before typechecking for quick feedback.
Warnings also fail lint and staged pre-commit checks.
`noUselessConstructor` is an error; Biome recognizes constructors needed to expose
a protected base constructor publicly. `useLiteralKeys` is
disabled because it conflicts with TypeScript's `noPropertyAccessFromIndexSignature`.

Builds run in dependency order with at most three workspace tasks at once.
The Standalone and Platform build scripts each own their frontend build, so the
root build excludes those frontend packages to avoid duplicate builds and races
with Vite clearing their output directories.

PRs, merge groups, main pushes, and manual CI runs execute the components of
`pnpm check` in ten parallel jobs: lint, typecheck, Knip, and seven coverage
suites. Each coverage job owns its build outputs. CLI, SDK, integration, E2E,
and web suites each use up to four file workers; builds use three workspace tasks.
The required `check` status merges coverage and requires every job to succeed.
Coverage percentages are advisory. CI saves the report as an artifact without
blocking on upload failures. See `TESTING.md` for focused suite commands.

## Hosting profiles

`relay-core` depends directly on Cloudflare and owns the shared Durable Objects,
D1 and R2 implementations, and shard migrations. Keep implementations in the
existing gateway, infra, storage, and durable-objects folders rather than adding
a separate Cloudflare adapter package. Platform and Standalone compose this
shared implementation and inject their Project authorization gateway.

Cloudflare Platform and Standalone are separate products at their public entry
points. Platform uses Clerk organizations as tenants (`tenantId = org_...`) and
verified active-organization claims for developer membership. Clerk owns
organization selection, creation, naming, and membership; Platform retains local
quota, lifecycle, and audit records. Platform owns OIDC, App, AppCredential, and
ConversationAccessCredential. Standalone owns accountless Project bootstrap and
Owner Capability. Shared Relay services consume normalized access contexts and
an opaque storage locator; they do not decide which hosting credential is valid.

Run Platform locally with `pnpm dev:cloudflare:platform`. Its OIDC provider,
operator subject, and exact browser origin JSON variables are documented in
[Cloudflare Platform hosting](./docs/platform-hosting.md). Never enable a public
accountless bootstrap in that entry point or mount Platform credential routes in
the default Standalone entry point.

The reusable local daemon entry is `@moxt-ai/mobius/runtime`. Keep CLI parsing
and host signal handling outside the engine, and keep AppCredential, OIDC, and
Conversation credential values out of its configuration. See [Embedded Mobius
Runtime](./docs/runtime-sdk.md).

## Pairing scope ownership

Pairing is scoped to a Project only. Relay services never see a tenant: storage
placement is resolved per Project by the host's `ProjectStorageDirectory`, and
scoping keys are derived from `projectId` alone. Embedding applications supply
the directory and required Runtime, Session, and connection gateways to
`createWorkerContext`, which assembles the pairing service. Hosting entrypoints
construct their Cloudflare gateways explicitly. Durable Object hosts use
`createDurableObjectContext` with bindings and content placement; they do not
construct SQL adapters, R2 content stores, channel peers, or alarm schedulers.

Platform Project IDs use `prj_<shard-code>_<local-id>`, for example
`prj_a01_<24-character-base64url-token>`. A shared local mapping resolves `a01`/`a02`
to D1 `apac-01`/`apac-02` and R2 `apac`, and `w01`/`w02` to D1 `wnam-01`/`wnam-02`
and R2 `wnam`. The local ID has 144 bits of randomness.
The mapped logical D1 shard and regional R2 bucket are checked
against configured bindings locally in Workers and Durable Objects, without a
placement database lookup. Placement is immutable for an ID; physical bindings
may change while keeping their logical names. Unencoded IDs are rejected by
Platform storage routing. Routing does not grant access: credential, ownership,
and lifecycle checks remain at their authorization boundaries.

Other applications can resolve one ID with the public, database-free endpoint
`GET /mobius/api/v1/projects/:projectId/storage-placement`. For an `a01` ID, it
returns only `{ "location": "apac" }`; `w01`/`w02` IDs return `{ "location": "wnam" }`.
This decodes placement only; it does not check Project existence or grant access.
Malformed IDs and unknown shard codes return HTTP 400 with `invalid_request`;
mapped placements missing configured bindings return HTTP 400 with
`storage_location_unavailable`.

The control plane stores administrative Project metadata directly in `platform_projects`.
Request authorization reads ownership and lifecycle from
`platform_project_authorizations` in the shard encoded by the Project ID.
Provisioning creates that record before returning success; there is no central
authorization fallback or Project KV cache. App deletion installs
shard-local App tombstones, including protection against late provisioning.
Migration `0011_platform_project_authorizations.sql` assumes a clean data reset;
existing central Project rows are not backfilled.
Platform-owned SQL is grouped under `packages/relay-cloudflare-platform/migrations`:
`sharding/` stores Project credential scopes, Session and Conversation credentials,
and Project audit events; `dashboard/` stores the administrative directory and
`platform_dashboard_audit_events` for events without a Project. Project rows route
by their encoded Project ID. Tenant audit reads return dashboard events;
`GET /mobius/api/v1/projects/:projectId/audit-events` returns only that Project's
audit events after verifying developer membership in its owning tenant. Parent App credentials and lifecycle checks still
use the dashboard directory, so revocation is authoritative without cross-shard
revocation writes. Conversation issuance, rotation, revocation, and browser-session
requests use `/mobius/api/v1/projects/:projectId/...` and access only the corresponding
shard. The SDK requires `projectId` and includes it directly in resource request
paths, including SSE reconnects and artifacts. Session lookup uses the Project ID
in its URL path. Neither credential type discovers its Project by scanning shards.

All Project-scoped endpoints share that prefix, including
`conversations/:conversationId/access-credentials`,
`conversation-access-credentials/:credentialId/rotate` and `/revoke`, and
`client/session` with its messages, history, events, configuration, Turns,
interactions, and artifacts. Regional routing extracts one Project path segment;
resource-specific query parameters never select a region. The old unscoped
Conversation/browser URLs are removed, and `project_id` query scoping is rejected.
Deploy the updated SDK consumers together with Platform for this URL cutover.

This credential cutover assumes a clean reset: dashboard migration
`0009_shard_project_credentials.sql` discards old scopes, access credentials, and
audit history. Reissue scoped App credentials and browser access after rollout.
The Platform Wrangler wrapper applies shared Relay migrations, then Platform
`sharding/` migrations using `platform_sharding_migrations`, then `dashboard/`
migrations before deployment. Standalone does not apply Platform sharding SQL.
Placement is derived only from the encoded ID; migration
`0006_drop_project_storage_placements.sql` removes the redundant placement table.

Cloudflare adapters own a fixed tenant label used only for Durable Object naming.
Standalone Workers configure `MOBIUS_TENANT_ID` (the supplied Wrangler profiles
use `standalone`); the Platform entry point uses the fixed `platform` label.
The embedded `Pair` component requires `getPairingToken(signal)`. Authenticated
hosts return their identity token; the standalone page explicitly returns `null`
and relies on the server's configured bootstrap policy.

Bootstrap pairing creates a project, channel, runtime, and persistent project-owner
credential. An authenticated project owner can add runtimes to that project;
additional runtime pairing preserves the project and owner credential. Revoking
a runtime does not revoke project ownership. Standalone Pairing and Session responses
do not expose their internal hosting placement. Platform Tenant quotas aggregate
Projects and Sessions assigned to the same storage locator. Previously issued
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
the version is unchanged, and publishes to npm. Main pushes rely on the merge
queue's checks; publishing builds the release artifacts through each package's
`prepack` script.

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

## Publishing the Protocol and SDK

`.github/workflows/publish-sdk.yml` publishes `@moxt-ai/mobius-protocol` and
`@moxt-ai/mobius-sdk` independently when either package version changes on
`main`. It detects both changes against the pushed commit's base, packs only the
changed release artifacts with pnpm, and prints an npm publication dry run before
publishing. pnpm packing applies `publishConfig` and replaces workspace
dependencies with registry versions.

The SDK depends on `@moxt-ai/mobius-protocol`. When both versions change, the
workflow publishes Protocol first and waits for that exact Protocol version to
be available from npm before publishing SDK. When only the SDK changes, it
stops unless the matching Protocol version is already on npm. Existing exact
versions are skipped so a GitHub Actions re-run can recover from a partial
release without attempting to overwrite an immutable npm version. Registry
failures other than 404 stop the release. A manual dispatch from `main` provides
the same recovery path for the current versions.

Configure npm trusted publishing for **both** packages with organization
`moxt-ai`, repository `mobius`, workflow `publish-sdk.yml`, no environment, and
direct `npm publish` enabled. The workflow uses GitHub-hosted OIDC, installs
npm 11.5.1 before publishing, and deliberately removes token-based npm
configuration so no `NPM_TOKEN` repository secret is required. For a package
that does not yet exist, bootstrap its first publication with an authorized npm
account, then configure its trusted publisher.

To inspect the exact release artifacts locally without publishing:

```bash
mkdir -p /path/to/release-preview
pnpm --dir packages/protocol pack --out /path/to/release-preview/mobius-protocol.tgz
pnpm --dir packages/mobius-sdk pack --out /path/to/release-preview/mobius-sdk.tgz
npm publish /path/to/release-preview/mobius-protocol.tgz --access public --dry-run
npm publish /path/to/release-preview/mobius-sdk.tgz --access public --dry-run
```

Adding the workflow alone does not release a version; merge a Protocol or SDK
version bump after the npm publishers are configured.

## Adding a Local Agent

See [Local Agent Integration](./docs/local-agent-integration.md) for the module
boundaries, trust constraints, registration point, and verification checklist.
