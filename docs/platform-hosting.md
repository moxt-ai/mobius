# Cloudflare Platform hosting

After this, an operator can deploy the multi-tenant Platform Worker, provision
an App and its Projects with OIDC, and give a trusted backend and an authorized
browser credentials from separate trust planes.

`@moxt-ai/mobius-relay-cloudflare-platform` is a Worker entry point independent
from `@moxt-ai/mobius-relay-cloudflare-standalone`. Both compose the shared
Project, Runtime, Bot, Conversation, and Session services. Platform adds its own
Tenant, App, AppCredential, developer authentication, and browser Conversation
credential control plane. It does not serve the accountless public bootstrap.
Standalone does not mount Platform routes unless a host explicitly constructs
the legacy compatibility entry while migrating an older deployment.

## Cloudflare resources

Create two D1 databases before the first remote deployment:

- `DIRECTORY_DATABASE` stores shared Project resources and uses
  `packages/relay-core/migrations/d1`.
- `PLATFORM_DIRECTORY_DATABASE` stores Tenant, App, AppCredential,
  ConversationAccessCredential, and Platform audit records and uses
  `packages/relay-cloudflare-platform/migrations/d1`.

Copy `packages/relay-cloudflare-platform/wrangler.jsonc` into deployment-owned
configuration and add each database's `database_name` and `database_id`. Do not
point both bindings at one database: they have separate ownership and migration
histories. The Worker also creates independent Runtime Relay, Session Relay, and
Bot Connection Durable Object namespaces.

Configure these JSON-encoded Worker variables:

```json
{
  "MOBIUS_PLATFORM_ALLOWED_ORIGINS": "[\"https://app.example.com\"]",
  "MOBIUS_PLATFORM_OIDC_PROVIDERS": "[{\"providerId\":\"clerk\",\"issuer\":\"https://issuer.example.com\",\"audience\":\"mobius-platform\",\"jwksUrl\":\"https://issuer.example.com/.well-known/jwks.json\",\"allowedAlgorithms\":[\"RS256\"],\"safeMetadataClaims\":[\"email\",\"name\"]}]",
  "MOBIUS_PLATFORM_OPERATOR_SUBJECTS": "[\"oidc-subject-allowed-to-create-tenants\"]"
}
```

OIDC provider IDs, issuers, audiences, algorithms, and JWKS URLs are deployment
configuration, never request input. The Worker verifies the provider registry,
signature, issuer, audience, lifetime, and subject before consulting Platform
developer membership. An OIDC identity is not a Tenant member merely because it
is valid. Operator subjects can create the first Tenant; subsequent Tenant/App
access comes from persisted developer membership.

Allowed browser origins are exact `http` or `https` origins. Wildcards, URL
paths, credentials, query strings, and fragments are rejected. The allowlist is
applied only to `/mobius/api/v1/client/session/*`; CORS is a browser hardening
layer and never substitutes for the Conversation credential check.

Build either profile independently:

```bash
pnpm --filter @moxt-ai/mobius-relay-cloudflare-platform build
pnpm --filter @moxt-ai/mobius-relay-cloudflare-standalone build
```

After database IDs and authentication variables are configured, deploy Platform
from the repository root:

```bash
pnpm deploy:cloudflare:platform
```

The command applies both remote D1 migration streams before publishing the
Worker. A migration failure stops deployment. It never migrates or deploys the
Standalone Worker.

CI deploys staging and production using the `mobius-relay-production` GitHub
environment. Its `CLOUDFLARE_API_TOKEN` must retain account access for Worker
uploads, D1 migrations, R2 bindings, and custom domains, plus Zone Read and
Workers Routes Edit access to both `paradev.biz` and `paraflow.biz`. A token
that can upload a Worker can still fail when Wrangler reads or updates routes.

The checked-in Platform configuration is authoritative for CI deployments.
Platform CI omits Wrangler's `--strict` option so Workers bootstrapped through
the script API can be updated from the repository. Such deployments replace
remote code and configuration with the checked-in version.

For local development, apply both migration directories through the package's
Vitest harness or Wrangler local D1, then run:

```bash
pnpm dev:cloudflare:platform
```

## Credential planes

The entry point selects the trust plane from a fixed route before decoding a
credential:

| Caller | Credential | Routes and authority |
| --- | --- | --- |
| Platform developer | configured OIDC token plus `x-mobius-oidc-provider` | Tenant, App, Project, and AppCredential provisioning |
| trusted App backend | `mapp_...` AppCredential | explicitly scoped shared Project/Runtime/Bot/Conversation operations |
| authorized browser | `mconv_...` ConversationAccessCredential | one server-bound Conversation and Session under `/v1/client/session/*` |
| local daemon | Runtime credential | one Runtime Relay connection and its lease/fence |

App keys (AppCredentials) do not expire, including previously issued keys after
the `0005_non_expiring_app_keys.sql` migration. Issuance and rotation no longer
accept `expiresInSeconds`, and AppCredential responses omit `expiresAt`.
AppCredential secrets and Conversation credential secrets are returned only
when issued. D1 stores their digests. Rotation creates a new credential revision;
the old AppCredential remains valid only for its explicit overlap. Revocation,
Conversation credential expiry, parent AppCredential revision, App lifecycle, Project lifecycle, and
Conversation lifecycle are rechecked for every browser request. Active browser
event streams close on explicit revocation and periodically reauthorize so a
cross-isolate or parent lifecycle change also terminates the stream.

The browser route never accepts a Project, Conversation, Session, Bot, or Runtime
target. Query and body fields attempting to choose those resources are rejected;
the server reads the exact IDs from the credential record. Turn and artifact IDs
are subordinate resources of that already-fixed Session and are reauthorized by
the Session service.

## Backend flow

Use `@moxt-ai/mobius-sdk/platform` with OIDC to create a Tenant and App. App
creation returns its default AppCredential once. The same default credential can
provision multiple Projects and use `@moxt-ai/mobius-sdk/server` for Project,
Runtime pairing, Bot, Conversation, Turn, Interaction, Event, and Artifact
operations. Add another AppCredential only for a real independent deployment or
secret boundary.

Runtime pairing is deliberately pollable. A backend creates a pairing with a
stable idempotency key, shows the one-time code to the local operator, and polls
pairing status with the AppCredential until it is paired or terminal. Runtime
registration and current online presence remain separate fields. No Project
event stream or webhook is required for the initial integration.

If the application allows its browser to connect directly, the backend first
authorizes its own user and business conversation, then issues a short-lived
ConversationAccessCredential for the existing Mobius Conversation and Session.
It returns only that `mconv_...` value to the browser. The browser uses
`@moxt-ai/mobius-sdk/browser`; it cannot construct Platform, Project, Runtime,
Bot, or credential-management clients from that entry point.

Moxt uses the server-only path: the Moxt browser authenticates only to Moxt,
while Moxt Server holds one AppCredential and translates Mobius events into its
existing realtime protocol. No Mobius AppCredential or Conversation credential
is sent to the Moxt browser.

## Standalone boundary

The Standalone Worker installs only accountless Project ownership and the shared
Project routes. Platform Application and OIDC paths are not mounted and return
404. Legacy authentication routes and compatibility constructors are not
provided.
## App Project provisioning

Registered applications create Projects with their server-held AppCredential via
`POST /mobius/api/v1/apps/:appId/projects` or
`MobiusPlatformAppClient.createProject(appId, request, signal)`. The credential
must belong to the requested App, cover all Projects, and include the complete
server permission set. Developer OIDC is also supported on the same route.
Authentication middleware selects one method and verifies it; a verification
failure never falls back to another method. Resource authorization remains in
the control-plane service.

The request contains `displayName`, `clientReference`, `idempotencyKey`, and a
logical `locationHint` such as `apac` or `wnam`. Applications do not pass D1 shard
or R2 bucket identifiers. Platform resolves the hint to the first configured shard
in that location and its matching bucket, then stores that placement on the
Project. Unavailable locations are rejected with `storage_location_unavailable`.
An idempotent replay uses the logical request and returns the existing Project;
it does not move the Project when the registry configuration changes.
