# Project authentication and credential operations

Mobius can authorize accountless owners, short-lived browser access,
externally authenticated users, and server applications in the same
deployment. Every Project-facing path resolves one presented credential into a
readonly `ProjectAccessContext` containing the exact Tenant and Project,
server-owned permissions, credential ID, lifetime, and audit actor. Project
services authorize permissions; they do not branch on the login source.

Runtime daemons, Bot Connections, and Bot executions use separate trust planes:

| Plane | Trusted result | Accepted authority |
| --- | --- | --- |
| Project control | `ProjectAccessContext` | Only its Project and permission set |
| Runtime data | `RuntimeAccessContext` | One Project, Runtime, Channel credential, and live lease/fence |
| Connector data | `BotConnectionAccessContext` | One Bot Connection, audience, and connector scopes |
| Bot outbound execution | `RuntimeAccessContext` plus `ExecutionPermit` | One pinned execution, operation, target set, expiry, and use limit |

An `ExecutionPermit` is the result of checking an authenticated Runtime against
the opaque, server-backed `BotExecutionCapability`. It is not an identity. The
daemon-local `LocalBotGrant` remains the final approval for the resolved Agent,
executable, workspace, adapter capabilities, unattended policy, and outbound
targets, and never leaves the local machine.

## Project permissions

Application and external-identity grants use an explicit subset of these
permissions:

| Area | Permissions |
| --- | --- |
| Project and events | `project:read`, `project:event:read` |
| Runtime | `runtime:read`, `runtime:pair`, `runtime:revoke` |
| Bot | `bot:read`, `bot:profile:write`, `bot:behavior:write`, `bot:binding:write`, `bot:connection:manage` |
| Conversation | `conversation:create`, `conversation:read`, `conversation:turn:create`, `conversation:turn:cancel`, `interaction:respond` |
| Session and Artifact | `session:read`, `session:write`, `session:delete`, `artifact:read`, `artifact:write` |
| Authentication administration | `application:manage`, `identity-binding:manage`, `owner-credential:manage` |

Owner capabilities receive the full set. Linked-device and short-lived browser
credentials receive the fixed interactive set and cannot administer
applications, identity bindings, owner credentials, Runtime pairing, Runtime
revocation, or Bot configuration.

## Route authorization matrix

Paths below are relative to `/mobius/api`.

| Operation | Required input |
| --- | --- |
| `POST /pairings` | Public bootstrap policy; creates a new one-time accountless capability |
| `POST /v1/projects/{projectId}/runtime-pairings` | Project access with `runtime:pair` |
| `GET /v1/projects/{projectId}/runtime-pairings/{pairingId}` | Project access with `runtime:read` |
| `POST /v1/runtime-pairings/{pairingId}/redeem` | Matching one-time pairing ID and code |
| `GET /v1/runtimes/connect` | Matching Runtime Credential only |
| `GET /v1/projects/{projectId}/runtimes` | Project access with `runtime:read` |
| `DELETE /v1/projects/{projectId}/runtimes/{runtimeId}` | Project access with `runtime:revoke` |
| `POST /v1/auth/exchanges/{providerId}` | External bearer token accepted only by that configured provider |
| External identity binding routes | Project access with `identity-binding:manage`; attach also requires a fresh external proof |
| Application and application-credential routes | Project access with `application:manage` |
| Owner-credential routes | Project access with `owner-credential:manage` |
| Bot profile, behavior, and Binding routes | Matching Bot write permission |
| Project-side conversation and Turn routes | Matching conversation permission |
| Project and conversation reads | Matching read permission |
| Runtime WebSocket, catalog, and execution events | Matching Runtime credential only |
| `/v1/bot-executions/{executionId}/...` | Matching Runtime credential and execution capability |
| `/v1/bot-connections/{connectionId}/...` | Matching Bot Connection credential and connector scope |

Each route group selects its trust plane before credential verification. The
Project dispatcher uses the credential scheme and public credential ID; it does
not catch an authentication error and try Runtime or Connector stores. An OIDC
outage therefore affects only new external verification and exchange, not
already-issued Mobius, accountless, application, Runtime, or Connector
credentials.

Standalone tenant-scoped discovery is the explicit read-only exception:
unauthenticated `GET /v1/projects`, `GET /v1/projects/{projectId}/status`, and
legacy `GET /v1/projects/{projectId}/bots` resolve only the operator-configured
tenant. Supplying an Authorization header selects the authenticated
`bot:read` path instead. Public discovery never grants mutation, Runtime,
Connector, execution, or credential-management authority.

## Accountless bootstrap and recovery

`POST /pairings` still creates a Project, its first Runtime pairing, and a
high-entropy owner capability without account registration. D1 stores only its
digest. Project ownership is independent of Channel and Runtime lifecycle, so
revoking the first Runtime does not remove Project administration.

Public Project creation is enabled by default and bounded with Worker variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PUBLIC_PROJECT_BOOTSTRAP_ENABLED` | `true` | Set to `false` to disable new public Projects without disabling existing capability access |
| `PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT` | `10` | Per normalized client-address digest in the window |
| `PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT` | `100` | Deployment-tenant total in the window; must be at least the client limit |
| `PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS` | `3600` | Fixed accounting window, at most 24 hours |

The Relay accepts only an IP-shaped `CF-Connecting-IP` value for per-client
accounting, hashes it before persistence, and falls back to a shared
`unavailable` bucket. The tenant-wide bound still applies when no trusted
address is available. A disabled policy returns 403; an exhausted bound returns
429.

List and rotate owner credentials with the SDK:

```ts
const directory = await authentication.ownerCredentials.list(signal);
console.warn(directory.recoveryWarning);

const replacement = await authentication.ownerCredentials.rotate(
  directory.credentials[0].credentialId,
  { overlapSeconds: 300 },
  signal,
);
credentialProvider.replace(replacement);
```

The replacement plaintext is returned once. The old owner credential remains
valid only through `overlapEndsAt`; the Project-owner and Channel-host
authorization paths observe the same deadline. Explicit revocation ends access
immediately.

Loss of the last active owner capability is not recoverable through an account
provider unless a verified external identity was attached beforehand. Before
revoking or discarding that last capability, attach and test another owner path,
or store the replacement in a recoverable server-side secret manager. Mobius
does not implement password, email, MFA, or social-account recovery.

## Project applications

Application creation and credential issuance are separate auditable actions.
Plaintext credentials are returned only by issue or rotate responses. D1 stores
the public credential ID, digest, exact permissions, expiry, last-used time,
replacement relationship, overlap deadline, and revocation state.

```ts
import {
  MobiusProjectAuthenticationClient,
  RotatingMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

const authentication = new MobiusProjectAuthenticationClient({
  credentialProvider: ownerCredentialProvider,
  endpoint: "https://mobius.example.com",
  projectId,
});

const application = await authentication.applications.create(
  {
    name: "conversation-service",
    permissions: [
      "bot:read",
      "conversation:create",
      "conversation:read",
      "conversation:turn:cancel",
      "conversation:turn:create",
      "interaction:respond",
      "session:write",
    ],
  },
  signal,
);
const issued = await authentication.applicationCredentials.issue(
  application.applicationId,
  { expiresInSeconds: 30 * 24 * 60 * 60 },
  signal,
);
const applicationCredential = new RotatingMobiusCredentialProvider(issued.credential);
```

The application credential must stay in a server secret store. It must never
enter a browser bundle, URL, Agent prompt, Runtime environment, event payload,
workspace metadata, or local grant. An end user's host-session authorization is
still enforced by the host application; an opaque `actorReference` is audit
context only and cannot widen the application's Mobius permissions.

## External OIDC identity

The relay-core OIDC adapter uses Web Crypto and accepts configured `RS256`,
`PS256`, and `ES256` algorithms. It verifies the signature, exact issuer,
intended audience, `exp`, `iat`, optional `nbf`, bounded subject, and configured
algorithm. JWKS responses, key counts, token sizes, network waits, and cache
lifetime are bounded. A cache miss for a new `kid` refreshes the configured
JWKS once so normal provider key rotation can proceed.

The standalone Worker has no external provider by default. A self-hosted entry
point can register one or more authenticators explicitly:

```ts
import {
  ExternalIdentityAuthenticatorRegistry,
  OidcExternalIdentityAuthenticator,
  OidcProviderConfiguration,
  RegisteredExternalIdentityAuthenticator,
} from "@moxt-ai/mobius-relay-core";
import {
  BotConnectionActor,
  createStandaloneWorker,
  LiteSessionRelay,
  RuntimeRelay,
  SessionRelay,
  StandaloneAuthenticationConfiguration,
} from "@moxt-ai/mobius-relay-cloudflare-standalone";

const issuer = "https://example.clerk.accounts.dev";
const clerk = new OidcExternalIdentityAuthenticator(
  new OidcProviderConfiguration(
    "clerk",
    issuer,
    "mobius-production",
    new URL(`${issuer}/.well-known/jwks.json`),
    ["RS256"],
    [],
    5 * 60 * 1_000,
    60 * 1_000,
    10 * 1_000,
  ),
);
const authentication = new ExternalIdentityAuthenticatorRegistry([
  new RegisteredExternalIdentityAuthenticator("clerk", clerk),
]);

export { BotConnectionActor, LiteSessionRelay, RuntimeRelay, SessionRelay };
export default createStandaloneWorker(
  new StandaloneAuthenticationConfiguration(authentication),
);
```

Use the exact Clerk issuer, audience, and JWKS URL for the deployed instance;
do not copy the placeholder. Clerk documents the Frontend API issuer and its
[`/.well-known/jwks.json` endpoint](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
in its manual JWT verification guidance. Issuer, audience, algorithms, and safe
metadata claim names are deployment configuration, not client input. Prefer no
metadata claims unless the host has a concrete display or correlation need;
metadata is never authorization.

### Attach and exchange

An accountless owner attaches an identity while proving both the current owner
capability and a fresh provider token:

```ts
const attached = await authentication.externalIdentityBindings.attach(
  {
    externalCredential: oidcToken,
    permissions: ["project:read", "bot:read", "conversation:read"],
    providerId: "clerk",
    revokeOwnerCredential: false,
  },
  signal,
);
```

This adds a grant to the existing Project. It does not change IDs or copy
Runtimes, Bots, Sessions, conversations, Bindings, or events. The owner may
request owner-credential revocation in the same operation, but should first
verify that exchange works.

Subsequent requests exchange a provider token for a short-lived Mobius access
credential:

```ts
import { ExchangingMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";

const provider = new ExchangingMobiusCredentialProvider(
  authentication,
  "clerk",
  clerkSessionTokenProvider,
  10 * 60,
  30_000,
);
```

The exchange is `POST /v1/auth/exchanges/{providerId}` with the external token
as the bearer credential and `{projectId, expiresInSeconds}` as its body. A
valid external identity has no Project authority until an active server-owned
grant for its exact `(providerId, issuer, subject)` exists. Organization, role,
scope, Tenant, Project, permission, and actor claims do not create a grant.
Provider tokens are never written to D1, audit details, Session or Bot state,
Runtime state, or local workspace metadata.

## Moxt server integration

The runnable TypeScript example at
[`packages/web-sdk/examples/moxt-server.ts`](../packages/web-sdk/examples/moxt-server.ts)
provisions three applications and stores each one-time plaintext credential
through a caller-supplied secret-vault port:

| Application | Responsibility |
| --- | --- |
| `moxt-provisioner` | Runtime pairing/revocation and Bot profile, behavior, and Binding management |
| `moxt-conversation-service` | Project-side conversation creation, config revision, Turn submission/cancellation, and Interaction response |
| `moxt-event-projector` | Project, Bot, conversation, Session, and event reads |

Import `provisionMoxtApplications` only in a trusted provisioning process. At
normal startup, load the three secrets into `MoxtServerCredentialSet` and build
`MoxtServerClients`. The clients use the same Project routes and receive the
same `ProjectAccessContext` shape, but the Relay enforces each application's
different permission set. A request handler calls
`clients.conversationService(opaqueMoxtActorReference)` so the sanitized opaque
reference is retained for audit without becoming an authorization claim.

Moxt keeps its user, organization, Workspace, and Teammate policy. A browser
sends only its Moxt session to Moxt; Moxt resolves the Workspace's Mobius
Project and uses the relevant server-held application credential. The example
does not construct `MobiusBotConnectorClient`: Teammate and Workflow
conversations are Project-side operations. Create a Bot Connection only when
adopting the separate external-connector ingress and durable-delivery contract.

## Credential rotation runbook

1. Read the application or owner credential directory and record the current
   public credential ID, expiry, last-use time, and any existing replacement.
2. Call the rotate operation once with the new expiry and the shortest overlap
   that safely covers deployment. Rotation is atomic; concurrent attempts on
   the same source credential return a conflict without creating another live
   replacement.
3. Store the returned plaintext immediately in the intended secret manager. Do
   not log it, put it in a command argument, commit it, or return it to a browser.
4. Deploy consumers with the replacement, then make an authorized read and
   confirm the new credential's `lastUsedAt` and successful audit event.
5. Check that no expected consumer still uses the old credential. During the
   reported overlap both old and new follow the published lifecycle.
6. Explicitly revoke the old credential when migration is complete, or let the
   bounded overlap expire. Revocation of one application must not affect other
   applications or accepted executions.
7. For an owner credential, verify another owner or attached external path
   before revoking the last usable capability. Keep the recovery warning in the
   operator workflow.

If a rotate response is lost after commit, do not invent or recover the
plaintext: list credentials, identify the replacement public ID, and rotate or
revoke again from a still-valid administration path. Authentication audit
events expose server-derived actor kind and ID, sanitized `actorRef`, action,
subject, result, and non-secret details.

## Threat model and operational invariants

- D1 stores only secret digests. Raw owner, browser, Mobius access, application,
  Runtime, Connector, and execution-capability tokens are not audit or event data.
- A valid external JWT authenticates an external subject only. Exact Mobius
  Project grants and permissions remain server-owned records.
- A Project credential is rejected at Runtime, Connector, and Bot-execution
  endpoints. Runtime and Connector credentials are likewise rejected from
  Project administration without probing unrelated credential stores.
- A Runtime can act only for its resolved Runtime and current fence. It cannot
  select an arbitrary Bot, Binding, execution, or outbound target.
- A Connector can use only its Bot, Connection, audience, scopes, and approved
  targets. It cannot choose a Runtime, Agent, workspace, executable, or local
  permission decision.
- Bot outbound actions require both the Runtime credential and a matching,
  unexpired, use-bounded `ExecutionPermit`. A general Project credential cannot
  replace either input.
- Cloud authorization can enqueue work but cannot approve local execution. The
  selected Binding and daemon-local `LocalBotGrant` are rechecked at the local
  side-effect boundary.
- `actorRef` and provider metadata are sanitized attribution only. Neither is
  an authority input.
- All authentication and directory waits are cancellable and have finite
  deadlines. Cancellation is not translated into an authentication failure or
  retry.

Apply forward D1 migration `0006_project_authentication.sql` before serving the
new routes. It preserves existing Projects and owner credentials, adds
credential overlap fields, external bindings/grants, Mobius access credentials,
applications, authentication audit events, and bootstrap-limit storage with
the lookup and lifecycle indexes used by request paths.
