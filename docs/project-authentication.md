# Project authentication and credential operations

Mobius Project services consume a readonly `ProjectAccessContext`: Project scope,
server-owned permissions, credential ID, lifetime, and audit actor. The hosting
entry point authenticates credentials and resolves that context. Shared services
authorize its permissions without branching on the hosting identity model.

Standalone owns accountless Project bootstrap and owner capabilities. Platform
owns OIDC developers, Tenant, App, AppCredential, and browser access credentials.
App provisioning and credential lifecycle APIs are available only through
`@moxt-ai/mobius-sdk/platform`; see [Platform hosting](./platform-hosting.md).
The general SDK has no Project Application resource or application credentials.

## Migrating App management to Platform

App management remains available in the SDK through
`MobiusPlatformDeveloperClient` from `@moxt-ai/mobius-sdk/platform`.
Replace the legacy `MobiusProjectAuthenticationClient` resources with these
Platform operations. HTTP paths below are relative to `/mobius/api` on the
Platform deployment:

| Legacy Project SDK operation | Platform SDK operation | Platform endpoint |
| --- | --- | --- |
| `applications.create({ name, permissions }, signal)` | `createApp(tenantId, displayName, signal)` | `POST /v1/tenants/:tenantId/apps` |
| `applications.list(signal)` | `listApps(tenantId, signal)` | `GET /v1/tenants/:tenantId/apps` |
| `applications.revoke(applicationId, signal)` | `deleteApp(appId, signal)` | `DELETE /v1/apps/:appId` |
| `applicationCredentials.issue(applicationId, request, signal)` | `issueAppCredential(appId, { permissions, projectIds }, signal)` | `POST /v1/apps/:appId/credentials` |
| Credentials included in `applications.list` | `listAppCredentials(appId, signal)` | `GET /v1/apps/:appId/credentials` |
| `applicationCredentials.rotate(credentialId, request, signal)` | `rotateAppCredential(credentialId, overlapSeconds, signal)` | `POST /v1/platform/app-credentials/:credentialId/rotate` |
| `applicationCredentials.revoke(credentialId, signal)` | `revokeAppCredential(credentialId, signal)` | `POST /v1/platform/app-credentials/:credentialId/revoke` |

This changes the ownership and authorization contract:

- A Platform App belongs to a Tenant and owns Projects. A legacy Project
  Application belonged to one Project. Legacy IDs and credentials are not
  automatically converted into Platform resources.
- App management requires a configured developer OIDC provider and authorized
  Tenant membership. An accountless Project owner capability does not grant
  Platform administration.
- `createApp` returns a default AppCredential once. For restricted access, issue
  another credential with explicit permissions and Project IDs belonging to
  that App. An empty `projectIds` list grants all-Project scope within the App.
- Permissions are selected when issuing a credential, not when creating an
  App. Platform AppCredentials do not expire, so issuance and rotation no
  longer accept `expiresInSeconds`. Rotation retains the credential scope and
  accepts an overlap of 0–3600 seconds.
- `deleteApp` uses Platform's deleted lifecycle and invalidates access through
  the App and its Projects. To end only one credential's access, use
  `revokeAppCredential`.

For example, given an authorized Tenant and a configured OIDC token:

```ts
import {
  MobiusAppCredentialProvider,
  MobiusOidcCredentialProvider,
  MobiusPlatformDeveloperClient,
} from "@moxt-ai/mobius-sdk/platform";
import { MobiusClient } from "@moxt-ai/mobius-sdk/server";

const developer = new MobiusPlatformDeveloperClient({
  endpoint: platformOrigin,
  authenticationProviderId: "clerk",
  credentialProvider: new MobiusOidcCredentialProvider(oidcToken),
});
const signal = AbortSignal.timeout(20_000);
const app = await developer.createApp(tenantId, "Conversation service", signal);
const project = await developer.createProject(app.appId, {
  clientReference: "customer-42",
  displayName: "Customer 42",
  idempotencyKey: "provision-customer-42",
  locationHint: "apac",
}, signal);
const issued = await developer.issueAppCredential(app.appId, {
  permissions: ["project:read", "runtime:read"],
  projectIds: [project.projectId],
}, signal);

const client = new MobiusClient({
  endpoint: platformOrigin,
  projectId: project.projectId,
  credentialProvider: new MobiusAppCredentialProvider(issued.credential),
});
try {
  const runtimes = await client.runtimes.list(signal);
  // Use the authorized Runtime directory in your backend.
} finally {
  client.close();
}
```

Persist one-time credential values in the backend's credential vault. Project
clients consume the credential-provider contract; App administration remains
in the Platform client. See the runnable
[`moxt-server.ts`](../packages/mobius-sdk/examples/moxt-server.ts) example for
vault-backed provisioning and backend client composition.

## Trust planes

| Plane | Trusted result | Accepted authority |
| --- | --- | --- |
| Project control | `ProjectAccessContext` | Only its Project and permission set |
| Runtime data | `RuntimeAccessContext` | One Project, Runtime, Channel credential, and live lease/fence |
| Connector data | `BotConnectionAccessContext` | One Bot Connection, audience, and connector scopes |
| Bot outbound execution | `RuntimeAccessContext` plus `ExecutionPermit` | One pinned execution, operation, target set, expiry, and use limit |

An `ExecutionPermit` is the result of checking an authenticated Runtime against
the opaque, server-backed `BotExecutionCapability`. It is not an identity.
The daemon independently resolves and validates the Agent executable, workspace,
adapter capabilities, and outbound target scope for every command. It does not
persist or request a separate local binding approval.

Each route group selects its trust plane before verification. A Project
credential cannot authorize Runtime, Connector, or Bot-execution endpoints.
Runtime and Connector credentials cannot authorize Project administration.
The Runtime accepts its own 43-character base64url credential format; it does
not interpret Platform credential types.

## Project permissions

| Area | Permissions |
| --- | --- |
| Project and events | `project:read`, `project:event:read` |
| Runtime | `runtime:read`, `runtime:pair`, `runtime:revoke` |
| Bot | `bot:read`, `bot:profile:write`, `bot:behavior:write`, `bot:binding:write`, `bot:connection:manage` |
| Conversation | `conversation:create`, `conversation:read`, `conversation:turn:create`, `conversation:turn:cancel`, `interaction:respond` |
| Session and Artifact | `session:read`, `session:write`, `session:delete`, `artifact:read`, `artifact:write` |
| Authentication administration | `identity-binding:manage`, `owner-credential:manage` |

Owner capabilities receive the full set. Browser credentials receive a fixed
interactive subset and cannot administer identity bindings, owner credentials,
Runtime pairing/revocation, or Bot configuration. Hosting entry points decide
which authentication-administration routes they expose. Standalone does not
mount external identity or authentication-audit routes.

## Accountless bootstrap and recovery

`POST /mobius/api/pairings` creates a Project, its first Runtime pairing, and a
high-entropy owner capability without account registration. D1 stores only its
digest. Project ownership is independent of Channel and Runtime lifecycle, so
revoking the first Runtime does not remove Project administration.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PUBLIC_PROJECT_BOOTSTRAP_ENABLED` | `true` | Disable new public Projects without disabling existing capability access |
| `PUBLIC_PROJECT_BOOTSTRAP_CLIENT_LIMIT` | `10` | Per normalized client-address digest in the window |
| `PUBLIC_PROJECT_BOOTSTRAP_TENANT_LIMIT` | `100` | Deployment total; must be at least the client limit |
| `PUBLIC_PROJECT_BOOTSTRAP_WINDOW_SECONDS` | `3600` | Fixed accounting window, at most 24 hours |

The Relay hashes an IP-shaped `CF-Connecting-IP` for per-client accounting,
falling back to a shared `unavailable` bucket. The deployment-wide bound still
applies. A disabled policy returns 403; an exhausted bound returns 429.

Standalone's unauthenticated Project discovery is read-only. It does not grant
mutation, Runtime, Connector, execution, or credential-management authority.

List and rotate owner credentials with `MobiusProjectAuthenticationClient`:

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

The replacement plaintext is returned once. The old credential remains valid
only through `overlapEndsAt`; explicit revocation ends access immediately.
Store the replacement before switching consumers. If the response is lost after
commit, list credentials and rotate or revoke through a still-valid owner path;
plaintext cannot be recovered. Losing the last owner capability loses access
unless another supported owner path is available. Mobius does not implement
password, email, MFA, or social-account recovery.

## Platform backend integration

[`moxt-server.ts`](../packages/mobius-sdk/examples/moxt-server.ts) demonstrates
Platform provisioning with a caller-supplied credential vault, then Project-side
Runtime, Bot, Conversation, Session, and event operations. The host keeps its
own user and workspace policy. Its browser sends a host session to the backend;
the backend resolves the Project and supplies credentials through the SDK's
credential-provider boundary. `actorReference` is sanitized audit context, not
an authorization claim.

All external authentication and directory waits are cancellable and bounded.
Cancellation is not translated into authentication failure or retried. Raw
credentials are never audit or event data, and cloud authorization never
replaces authorization at the local execution boundary.

## Storage upgrade

Apply all shared D1 migrations in order. Migration
`0010_drop_project_applications.sql` removes the unused legacy
`project_applications` and `project_application_credentials` tables. Historical
migrations remain intact for existing deployments. Platform Apps and
AppCredentials live in the separate Platform control-plane database.
