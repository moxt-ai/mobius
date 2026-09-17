# Mobius TypeScript SDK

`@moxt-ai/mobius-sdk` is the resource-oriented client for supported Node.js
environments and modern browsers. It talks only to the public Relay boundary;
switching between a self-hosted Relay and the managed service changes the
endpoint and credential provider, not the Session workflow.

Use the entry point that matches the caller's trust boundary:

| Entry | Caller | Exposed resources |
| --- | --- | --- |
| `@moxt-ai/mobius-sdk/server` | trusted Standalone or Platform backend | shared Project, Runtime, Bot, Conversation, Session, Turn, Event, Interaction, and Artifact clients |
| `@moxt-ai/mobius-sdk/platform` | Platform developer or trusted App backend | OIDC Tenant/App provisioning, AppCredential lifecycle, Project provisioning, and Conversation credential lifecycle |
| `@moxt-ai/mobius-sdk/browser` | third-party browser holding one short-lived credential | only the fixed Session's messages, turns, events, interactions, and artifacts |
| `@moxt-ai/mobius-sdk` | compatibility import | current combined legacy root surface |

The browser entry does not export Project, Runtime, Bot, Tenant, App, or
credential-management clients. Its requests target only
`/mobius/api/v1/projects/:projectId/client/session/*`; the server derives Conversation and Session
identity from the credential record rather than a URL, query, body, or custom
header target.

The package root exposes Session, Turn, Attempt, Event, Interaction, Artifact,
Runtime pairing, Runtime, credential, and portability resources. It has no React or Zustand
dependency. The built-in Web application's Channel control transport remains
available from `@moxt-ai/mobius-sdk/channel`, but Channel is an execution
connection and routing resource, not the identity of stored history.

## Install and runtime support

```sh
pnpm add @moxt-ai/mobius-sdk
```

The package supports Node.js 20.19 or later and modern browsers with Fetch,
Web Streams, Web Crypto, `AbortController`, and `AbortSignal.any`. It is an ESM
package. `@moxt-ai/mobius-protocol` is installed as its version-matched runtime
dependency.

## Configure a client

```ts
import {
  MobiusClient,
  StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

const client = new MobiusClient({
  credentialProvider: new StaticMobiusCredentialProvider(credential),
  endpoint: "https://mobius.example.com",
  projectId: "project-id",
});
```

A bare origin selects the default `/mobius/api` prefix. An endpoint ending in a
custom path selects that path as an embedding application's configured API
prefix.

The client defaults to a 20-second deadline for each finite operation, a
15-second connection deadline and 45-second liveness deadline for an event
stream, and four bounded reconnect attempts. Configure these with
`operationTimeoutMilliseconds`, `streamConnectionTimeoutMilliseconds`,
`streamLivenessTimeoutMilliseconds`, and `maxStreamReconnectAttempts`.

Call `client.close()` when the owner is disposed. It closes every active
subscription and releases its connection and liveness timers.

## Discover capabilities and Runtimes

```ts
const capabilities = await client.capabilities.read(signal);
const runtimes = await client.runtimes.list(signal);
```

API version `1` declares exactly one realtime transport: authenticated
Server-Sent Events with media type `text/event-stream`, event name
`mobius.session-event.v1`, and payload format version `1`. Capability discovery
also declares the two-stage Artifact protocol, browser-credential lifetime
bounds, export format version, available resources, and whether native Agent
context can be imported.

Each Runtime descriptor contains its online snapshot and the Agent catalog
reported through its authenticated daemon connection. Every ready Agent also
contains the normalized capabilities returned by its successful, bounded ACP
initialization and adapter-specific readiness probe, plus its locally reported
executable path and version as output-only metadata. Installable Agents are kept
separate because they have no verified runtime capabilities yet. Their status
distinguishes a missing Agent from a missing integration; the latter also carries
the detected Agent path and version. The descriptor never exposes launch
arguments or provider credentials. A public client can select an accessible
Runtime, but the Relay reauthorizes it and the local daemon remains the final
authority for executable, workspace, and side-effect access.

## Pair and revoke Project Runtimes

Only a client backed by a Project owner credential can use Runtime pairing
resources. Keep that credential in an authenticated server application; a
browser credential and a Runtime daemon credential are intentionally rejected.

```ts
import {
  MobiusPairedRuntimePairingStatus,
  MobiusRuntimePairingRequest,
} from "@moxt-ai/mobius-sdk";

const request = new MobiusRuntimePairingRequest(crypto.randomUUID());
const pairing = await ownerClient.runtimePairings.create(request, signal);

// Give pairing.pairingCode to exactly one local daemon claim flow.
// Reusing request returns this same pairing instead of allocating another.
const status = await ownerClient.runtimePairings.read(
  pairing.pairingId,
  signal,
);

if (status instanceof MobiusPairedRuntimePairingStatus) {
  console.log(status.runtimeId, status.machineName, status.agents);
}

await ownerClient.runtimes.revoke(pairing.runtimeId, signal);
```

`MobiusRuntimePairingLifecycle` publishes the `pending`, `paired`, `expired`,
and `revoked` lifecycle values. The SDK decodes them into
`MobiusPendingRuntimePairingStatus`, `MobiusPairedRuntimePairingStatus`,
`MobiusExpiredRuntimePairingStatus`, and
`MobiusRevokedRuntimePairingStatus`, so callers do not need an optional-field
state bag.

The Relay caps one Project at eight active pending or paired Runtimes. A retry
after an ambiguous create response must reuse the same idempotency key.
Revocation closes only the selected Runtime and does not fail over Sessions or
Bot conversations. Capability discovery reports this resource as
`capabilities.resources.runtimePairings`. The full HTTP and authority contract
is in [Project Runtime pairing](runtime-pairing.md).

## Credentials

Servers provide a hosting-authorized Project credential through
`StaticMobiusCredentialProvider` or their own rotating provider. The provider's
`credential(signal)` operation runs before every finite request and every event
reconnection.

An owner-authorized server can issue and revoke short-lived, project-scoped
browser credentials:

```ts
import { MobiusBrowserCredentialRequest } from "@moxt-ai/mobius-sdk";

const browserCredential = await ownerClient.credentials.issue(
  new MobiusBrowserCredentialRequest(300),
  signal,
);

await ownerClient.credentials.revoke(
  browserCredential.credentialId,
  signal,
);
```

Return only the short-lived browser credential from an authenticated
application endpoint. Never put the owner or server-held Project credential in
a browser bundle or browser example. A browser provider should cache the
short-lived credential, refresh it before `expiresAt`, and honor its supplied
abort signal.

`MobiusProjectAuthenticationClient` exposes external identity binding and exchange, accountless owner
rotation/revocation, and authentication audit events. Use
`RotatingMobiusCredentialProvider` to swap an owner secret after
rotation and `ExchangingMobiusCredentialProvider` to cache and refresh
short-lived Mobius access credentials from a host-supplied OIDC token provider.
See [Project authentication and credential operations](project-authentication.md)
for the permission matrix, Platform backend example, and recovery/rotation
runbook. App registration and AppCredential lifecycle belong exclusively to
`@moxt-ai/mobius-sdk/platform`.

The SDK does not loop on authentication failures. `credential_expired` and
`credential_revoked` are returned immediately. After obtaining a replacement,
an application may retry a read or reconnect a subscription. A Turn may be
retried only with the same idempotency key and the same request.

## Session, Turn, and Attempt workflow

Create a Session with a caller-owned correlation ID and one authorized initial
execution binding:

```ts
import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";

const session = await client.sessions.create(
  {
    agentId: "codex",
    bindingId: crypto.randomUUID(),
    directoryId: "workspace-ref",
    policy: new MobiusRecordingPolicy(
      "full",
      30 * 24 * 60 * 60 * 1_000,
      1_000,
      6_000_000,
    ),
    runtimeId: "runtime-id",
    sessionId: businessConversationId,
    title: "Architecture review",
  },
  signal,
);
```

The optional fifth `MobiusRecordingPolicy` argument sets how long completed
idempotency receipts remain reusable. It defaults to the Session retention and
must be between one minute and that retention. Shortening it does not shorten
the Session or event history.

Use `sessions.read`, `sessions.list`, `sessions.configure`, and
`sessions.delete` for the remaining lifecycle. Configuring a binding creates a
new explicit revision for future Turns. A previously accepted Turn stays pinned
to its original binding.

Submit a Turn with a stable business request identifier:

```ts
const accepted = await client.turns.submit(
  session.sessionId,
  {
    additionalDirectoryIds: [],
    artifactIds: [],
    content: "Inspect the project",
    idempotencyKey: businessRequestId,
    images: [],
    resources: [],
  },
  signal,
);

const outcome = await client.turns.read(
  session.sessionId,
  accepted.turnId,
  signal,
);
```

Turn is the accepted logical request. Attempt is one concrete execution of that
Turn. Query an Attempt separately with `client.attempts.read(sessionId,
attemptId, signal)`. Retrying the same Turn request with the same idempotency key
returns the original Turn; reusing the key with different input fails with
`idempotency_conflict`.

Turn submission does not accept Runtime, Agent, workspace, or Bot fields. The
Relay reads the server-owned Session binding and reauthorizes that exact Runtime
before dispatch.

## Realtime events and recovery

Subscribe before submitting when every event from a new Turn is required:

```ts
const subscription = await client.events.subscribe(
  session.sessionId,
  previousCursor,
  {
    receive: async (event) => {
      render(event.payload);
      return shouldContinue;
    },
  },
  signal,
);

await client.turns.submit(session.sessionId, request, signal);
await subscription.completed;
```

The observer is serial and therefore applies backpressure. Its cursor advances
only after `receive` succeeds. Returning `false` stops the subscription.
`subscription.close()` disconnects the local observation stream and
`subscription.cursor` exposes the last consumed cursor.

On interruption, the client reconnects with that cursor. Retransmitted or older
sequences are deduplicated, ordering gaps fail as invalid service responses,
and server-rejected cursors surface `invalid_cursor` or `cursor_expired`. The
server registers the live subscriber before reading catch-up data and merges
both sources by committed Session sequence. Each server subscriber is capped at
256 queued events; a slow consumer is disconnected instead of growing memory
without bound. Heartbeats keep an otherwise idle connection live.

If recovery is no longer possible, read the original Turn to determine its
current or terminal state and request a fresh history page. Client caches never
claim server persistence or execution guarantees.

Events for core messages, tool activity, and Turn terminal states have dedicated
SDK classes. Other validated Session events use `MobiusControlEvent`, whose
`kind` is stable and whose `encodedPayload` can be decoded with the corresponding
decoder exported from the package root. This includes permission and elicitation
requests used with the Interaction resource.

## Cancellation boundaries

These operations have intentionally different effects:

- Aborting the `AbortSignal` passed to a finite request cancels only that local
  HTTP wait.
- Calling `subscription.close()` disconnects only that local event observer.
- Calling `client.turns.cancel(sessionId, turnId, { idempotencyKey }, signal)`
  requests cancellation of the remote task and returns the current Turn.

Neither a local abort nor a disconnected stream claims that the Agent stopped.
Remote cancellation is idempotent and is observable through the Turn state and
Session event stream.

## Interactions

Permission and elicitation requests are committed Session events. An integrator
can also recover pending work after reconnecting:

```ts
const pending = await client.interactions.listPending(sessionId, signal);
const interaction = await client.interactions.read(
  sessionId,
  interactionId,
  signal,
);

await client.interactions.respond(
  sessionId,
  interactionId,
  new MobiusPermissionResponseRequest(
    "application-user-id",
    "selected",
    "allow-once",
  ),
  signal,
);
```

Use `MobiusElicitationResponseRequest` for elicitation responses. Response
acceptance is exact-once at the Session boundary; repeating the same response is
safe, while a conflicting response fails with `interaction_conflict`. These
responses express a request only. They cannot bypass the daemon's local
side-effect authority.

## Paginated history and tool details

```ts
import { MobiusPageRequest } from "@moxt-ai/mobius-sdk";

const page = await client.sessions.readMessages(
  sessionId,
  new MobiusPageRequest(50, cursor),
  signal,
);

const detail = await client.toolCalls.readDetail(
  sessionId,
  attemptId,
  toolCallId,
  signal,
);
```

Message pages contain bounded tool summaries. Full details are fetched only on
demand and have explicit `available`, `truncated`, `unrecorded`, or `deleted`
states. Session directories and committed Event history are also paginated with
`MobiusPageRequest`. `sessions.readNativeHistory` exists for migrated native
Agent history already owned by a Session; it does not expose or restore a native
Agent session identifier.

## Attachments and Artifacts

Large attachment bytes never travel in a Turn control message. First obtain a
bounded upload authorization, then transfer and validate the exact bytes:

```ts
const upload = await client.artifacts.createUpload(
  sessionId,
  new MobiusArtifactUploadRequest(
    file.name,
    file.type,
    bytes.byteLength,
    sha256,
  ),
  signal,
);

const artifact = await client.artifacts.uploadContent(
  sessionId,
  upload,
  bytes,
  signal,
);

await client.turns.submit(
  sessionId,
  {
    additionalDirectoryIds: [],
    artifactIds: [artifact.artifactId],
    content: "Use the attachment",
    idempotencyKey: businessRequestId,
    images: [],
    resources: [],
  },
  signal,
);

const download = await client.artifacts.download(
  sessionId,
  artifact.artifactId,
  signal,
);
```

The Relay validates ownership, upload token, media type, byte length, and SHA-256
digest before marking content available. The local daemon receives only a
server-resolved `mobius-artifact:` reference and downloads it with Runtime
authority. Downloads are authorized streams whose metadata, length, and digest
are verified by the SDK.

## Export and import

```ts
const exported = await source.sessions.export(sessionId, signal);

const imported = await destination.sessions.import(
  exported,
  new MobiusSessionImportBinding(
    crypto.randomUUID(),
    destinationRuntimeId,
    destinationAgentRef,
    destinationWorkspaceRef,
  ),
  signal,
);
```

Export format `1` carries the versioned Session record, bindings, Turns,
Attempts, committed events, Interaction records, tool-detail content manifests,
uploaded Artifacts, and native-history record when present. Import validates
ownership-independent integrity, relationships, event ordering, hashes, quotas,
and Artifact references before accepting the record.

The destination binding is mandatory and is authorized against the destination
project. Source bindings remain historical evidence; future Turns use the new
destination binding. Import does not promise native execution-context restore,
which is reported as `nativeContextImport: false` in capabilities.

## Errors and authorization

`MobiusApiError` preserves the Relay's stable code and HTTP status. Local caller
validation, local cancellation, operation timeout, connectivity failure, and an
invalid service response are represented by `MobiusValidationError`,
`MobiusCancellationError`, `MobiusTimeoutError`, `MobiusConnectionError`, and
`MobiusProtocolError`.

Stable server outcomes distinguish invalid credentials, insufficient scope,
quota exhaustion, invalid or expired cursors, unavailable Artifact details,
lifecycle conflicts, and indeterminate execution. Runtime descriptors report
offline status explicitly; a valid Turn remains durably queued instead of
claiming that an offline dispatch failed. Messages crossing the public boundary
are sanitized; original causes remain on the owning side of the boundary.

Every Session operation is authorized from the credential-derived Tenant and
Project. A client-supplied `tenantId` is never accepted as authority. The same
authorization applies to execution, history, Interactions, uploads, downloads,
exports, imports, and deletion.

## Reference Node and browser workflow

The repository reference implementations use one shared workflow in
[`workflow.ts`](../packages/mobius-sdk/examples/workflow.ts). The
[`Node example`](../packages/mobius-sdk/examples/node.ts) reads its endpoint and
application credential from environment variables. The
[`browser example`](../packages/mobius-sdk/examples/browser.ts) receives a
short-lived credential provider from its host application. These files are not
published as `@moxt-ai/mobius-sdk` entry points; copy or adapt them from the
repository when useful.

The Node reference expects these six environment values:

```sh
MOBIUS_ENDPOINT=https://mobius.example.com \
MOBIUS_CREDENTIAL=server-credential \
MOBIUS_PROJECT_ID=project-id \
MOBIUS_RUNTIME_ID=runtime-id \
MOBIUS_AGENT_ID=codex \
MOBIUS_WORKSPACE_REF=workspace-ref
```

It is a Node.js client for an existing Relay deployment; it does not provide a
Node Relay implementation. Neither reference implementation imports D1, R2,
Durable Object, SQLite, filesystem, or deployment-specific types. The Node
example's 120-second signal is an application-level local wait deadline; it does
not request remote cancellation if it expires.

## Bot connector API

The package also exports `redeemMobiusBotConnectionGrant` and
`createMobiusBotConnectorClient` for provider-neutral external connectors. The
client supports independently rotatable connection credentials, opaque delivery
targets, idempotent connected conversations and messages, resumable conversation
events, outbound claim pages, delivery acknowledgement, and connection
revocation. It never accepts local Runtime, Agent, executable, workspace,
permission, provider credential, or provider destination fields.

Bot is the stable project identity. A BotConversation pins immutable behavior
and approved binding revisions in a one-to-one Session extension, while Session
remains the execution-history aggregate. Existing direct-Agent Sessions keep
their original model and receive no invented Bot identity.

Server-side owner applications use `MobiusBotOwnerClient` for canonical Bot
Conversation history. `readConversationMessages` returns the same message
content as Session `readMessages`, augmented with Bot-facing identifiers;
`readConversationToolCallDetail` resolves complete activity detail without
exposing Session or archive identities. `waitForConversationEvents` performs a
bounded durable-cursor long poll, so callers resume after Relay restarts by
retrying the same opaque cursor. Targeted follow-ups are submitted with
`queueProjectConversationTurn` or `steerProjectConversationTurn`, and an
accepted queued Turn can be changed atomically with
`promoteProjectConversationTurnToSteering` while its target remains active.

See [Bots and external connectors](bots.md) for the full authorization model,
HTTP route contract, credential lifecycle, offline guarantees, SDK example, and
local outbound CLI.
