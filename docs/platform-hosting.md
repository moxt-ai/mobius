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

Create the directory database and configured Project shards before the first remote deployment:

- `D1_SHARD_APAC_01` and the other configured `D1_SHARD_*` bindings store Project
  resources. Apply shared `packages/relay-core/migrations/d1`, then
  `packages/relay-cloudflare-platform/migrations/sharding` using the independent
  `platform_sharding_migrations` history table.
- `PLATFORM_DIRECTORY_DATABASE` stores Tenant, App, AppCredential,
  and dashboard audit records and uses
  `packages/relay-cloudflare-platform/migrations/dashboard`.
  Session/Conversation access credentials, App credential Project scopes, and
  Project audit events belong to the encoded Project shard.

Copy `packages/relay-cloudflare-platform/wrangler.jsonc` into deployment-owned
configuration and add each database's `database_name` and `database_id`. Do not
point both bindings at one database: they have separate ownership and migration
histories. The Worker also creates independent Runtime Relay, Session Relay, and
Bot Connection Durable Object namespaces.

Bind a separate Workers KV namespace as `APP_CREDENTIAL_CACHE` for each
environment. The checked-in staging and production configurations include their
namespace IDs; local development uses a local namespace. KV bindings are not
inherited from the top-level Wrangler configuration.

Configure these JSON-encoded Worker variables:

```json
{
  "MOBIUS_PLATFORM_ALLOWED_ORIGINS": "[\"https://app.example.com\"]",
  "MOBIUS_PLATFORM_OIDC_PROVIDERS": "[{\"providerId\":\"clerk\",\"issuer\":\"https://issuer.example.com\",\"audience\":\"mobius-platform\",\"jwksUrl\":\"https://issuer.example.com/.well-known/jwks.json\",\"allowedAlgorithms\":[\"RS256\"],\"safeMetadataClaims\":[\"email\",\"name\"]}]",
  "MOBIUS_PLATFORM_OPERATOR_SUBJECTS": "[\"oidc-subject-allowed-to-read-platform-configuration\"]"
}
```

OIDC provider IDs, issuers, audiences, algorithms, and JWKS URLs are deployment
configuration, never request input. The Worker verifies the provider registry,
signature, issuer, audience, lifetime, and subject before authorizing organization
access. Platform uses the configured `clerk` provider and the active organization
in its signed token: `tenantId` is exactly the Clerk organization ID (`org_...`).
Clerk v2 `o.id`/`o.rol` and v1 `org_id`/`org_role` claims are supported. Include
those claims and the configured audience in the Clerk session token. Pending
sessions and sessions without an active organization cannot access tenant resources.

Create, select, rename, and manage organization membership through Clerk. The
Platform UI's selected tenant is Clerk's active organization. Organization members
share apps; `org:admin` authorizes the existing owner-only App operations. Every
developer request checks the requested resource against the verified active
organization. A request body or header cannot override that organization.

Platform lazily records organization-scoped quota, lifecycle, and audit data;
it does not generate tenant IDs or persist developer memberships. Tenant creation,
rename, and deletion endpoints and SDK methods have been removed. `listTenants`
returns the active organization only; Clerk provides the organization selector.
Migration `0007_clerk_organizations.sql` drops the old membership table. Existing
`ten_...` resource records are not automatically assigned to an organization:
moving existing data requires an explicit old-ID-to-Clerk-organization mapping.

### Shareable organization invite links

After this, an admin can share an organization invite link, and a recipient can
sign in, join, and see that organization's Platform dashboard.

Set the Worker secret `CLERK_SECRET_KEY` to the backend secret for the **same Clerk
instance** as the Platform publishable key and configured OIDC issuer. For local
development, put it in the Platform Worker's `.dev.vars`; for a deployed Worker,
use Wrangler's `secret put CLERK_SECRET_KEY` with the target environment. Never
use a `VITE_` variable for this secret. Apply the Platform migration stream,
including `0008_organization_invite_links.sql`, before running the new Worker.

Admins select **Invite members** beside the organization switcher, then **Create
invite link** and **Copy link**. Links are reusable for seven days and grant only
`org:member`. The full secret is returned once; D1 stores its SHA-256 digest.
The dialog lists up to 100 active links, with creation/expiry dates and a revoke
action. Creation, revocation, and successful acceptance produce Platform audit
events without recording invite tokens.

The `/join#<token>` page saves the token in tab-scoped session storage and removes
it from the URL before authentication. Clerk sign-in and sign-up return to `/join`.
Recipients need an active Clerk account but do not need an active organization.
After an explicit **Join organization**, Platform adds membership through Clerk,
selects that organization, refreshes the session token, clears the pending invite,
and opens the dashboard. Existing membership is preserved, including its role.

Management routes require both a matching active organization and current Clerk
admin membership. The authenticated preview/accept routes resolve the organization
from the invite; request bodies cannot select a role or target organization.
An acceptance already in progress when an admin revokes a link can finish;
revocation prevents subsequent redemptions and does not remove existing members.

Without `CLERK_SECRET_KEY`, invitation operations return `invite_links_unavailable`;
other Platform operations continue to use OIDC authentication.

Allowed browser origins are exact `http` or `https` origins. Wildcards, URL
paths, credentials, query strings, and fragments are rejected. The allowlist is
applied to `/mobius/api/v1/projects/:projectId/client/session/*`; CORS is a browser hardening
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

CI deploys staging and production using separate `staging` and `production` GitHub
environments. Their `CLOUDFLARE_API_TOKEN` must retain account access for Worker
uploads, D1 migrations, R2 bindings, Workers KV Storage, and custom domains,
plus Zone Read and Workers Routes Edit access to both `moxt.ws` and `moxt.ai`. A token
that can upload a Worker can still fail when Wrangler reads or updates routes.

GitHub Environment variables and secrets are authoritative for runtime settings.
Create individual GitHub variables for the three authentication variables above
plus `SESSION_ACTIVE_SESSIONS_PER_PROJECT` and `SESSION_ARCHIVE_BYTES_PER_SESSION`.
All values must be nonempty strings; authentication values contain JSON arrays.
Set the individual GitHub secret `CLERK_SECRET_KEY` to enable organization invites.
It is optional for deployments without invites. The workflow explicitly maps
each setting and calls `scripts/validate-worker-config.ts` before migrations,
then supplies variables and provided secrets to both regional Workers and the edge
Worker with their deployed versions. Worker region is topology owned by Wrangler
configuration. Wrangler preserves
existing secrets; explicitly delete retired bindings in Cloudflare.

Also set GitHub variables `CLERK_PUBLISHABLE_KEY` for the frontend build and
`CLOUDFLARE_ACCOUNT_ID`. Copy deployment credentials from the former shared
`mobius-relay-production` environment into both environments before the first CD
run. That original environment remains in use by the standalone Relay deployment.
Populate GitHub with existing runtime values before deployment; Cloudflare cannot
return secret plaintext, so recover those from the original store or rotate them.

The checked-in Platform configuration owns resource bindings and routes.
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
| Platform developer | verified Clerk token with active organization plus `x-mobius-oidc-provider: clerk` | Organization-scoped App, Project, and AppCredential provisioning |
| trusted App backend | `mapp_...` AppCredential | explicitly scoped shared Project/Runtime/Bot/Conversation operations |
| authorized browser | `mconv_...` ConversationAccessCredential | one server-bound Conversation and Session under `/v1/projects/:projectId/client/session/*` |
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

### App credential authentication cache

After this, a backend can reuse its existing App secret and see repeated
authentication served from Workers KV, with D1 credential reads and last-used
writes performed only on cache misses. There is no token exchange or SDK change.

Platform stores one versioned record per SHA-256 App secret digest in
`APP_CREDENTIAL_CACHE`. It contains the credential identity, permissions,
App/Tenant lifecycle, revocation and rotation metadata, and an absolute two-hour
expiry. Raw secrets are never stored in KV. Both active and revoked credentials
can be cached; unknown or incorrect secrets are not cached. Cache hits do not
extend expiry, and a known rotation overlap deadline is enforced on every hit.
`lastUsedAt` is sampled when an active credential is loaded from D1, rather than
written on each request. Project ownership and lifecycle are authorized against
the Project's D1 shard on every Project request. Selected-Project credential
grants still use the control-plane credential-scope table.

Revocation commits to D1, then deletes the hash-keyed cache record. Rotation
deletes the old credential's record; App deletion invalidates all
affected credentials. The next miss reloads current D1 state, including revoked
status. Invalid or expired cache records and failed KV reads fall back to D1.
Failed cache fills do not reject an otherwise valid D1 authentication; failed
invalidation returns a typed error after the D1 change has committed.

KV is eventually consistent. Reads use a 60-second edge cache lifetime, but
invalidation is not an immediate global revocation guarantee. If invalidation
fails or a concurrent stale fill completes after deletion, an active snapshot
can survive until its original two-hour expiry. That expiry is measured from
the start of the D1 read and is checked in the Worker as well as by KV.

The browser route never accepts a Project, Conversation, Session, Bot, or Runtime
target. Query and body fields attempting to choose those resources are rejected;
the server reads the exact IDs from the credential record. Turn and artifact IDs
are subordinate resources of that already-fixed Session and are reauthorized by
the Session service.

### Project-ID regional routing

After this, a backend can call the public Project API and have its request
authorized and executed by the Worker assigned to the Project's region.
The public Worker decodes the Project ID and forwards Project-scoped HTTP
requests with service-binding `fetch()` to `mobius-platform-<environment>-apac`
or `mobius-platform-<environment>-wnam`. No directory query is needed to route.
Credentials, bodies, streaming responses, and WebSocket upgrades remain on the
normal product boundary; the destination performs the existing authorization.
A backend rejects a Project from the other logical region with HTTP 421.
Requests without a Project in the URL continue through the public Worker.

`regional-placement.json` specifies explicit placement hints, separate from
logical shard names. APAC backends target Singapore and WNAM backends target the
western US. Placement hints select nearby Cloudflare execution and are not
data-center guarantees. The public router has placement disabled so it runs near
the caller.

Each product owns a small regional override template in `wrangler.regional.template.json`.
It contains only the Worker name, entrypoint, placement hint, logical region, and
deployment flags. Shared bindings and settings are inherited from the existing
Wrangler configuration. The renderer JSON-encodes `<%% name %%>` substitutions
and validates the rendered overrides before merging them. Public routes, assets,
router service bindings, migrations, and queue consumers are excluded from the
inherited settings; Durable Objects reference their existing owner Worker.

`pnpm wrangler deploy --config packages/relay-cloudflare-platform/wrangler.jsonc
--env staging` applies migrations, generates regional configurations under
`.wrangler/regional/staging`, deploys both backends, and finally deploys the public
router. `--dry-run` validates all three bundles. Regional Workers share the
existing D1/R2/KV resources and reference Durable Objects owned by the public
Worker; they do not create new Durable Object namespaces or queue consumers.
The same generator is used by Mobius Chat after its Vite build.

Public routing uses `MOBIUS_WORKER_REGION=edge`; backends use `apac` or `wnam`.
Unset means the existing single-Worker local-development mode. These are
deployment bindings, never request-header overrides. Regional fetches propagate
cancellation and bound the wait for response headers to two minutes.

### Shard-local Project authorization

After this, an App-wide backend can read a provisioned Project while the control
plane is unavailable, provided its App authentication is already cached. The
Worker decodes the Project ID to select a configured shard and reads
`platform_project_authorizations` there. It checks the App ID, Tenant ID, and
active lifecycle locally; it never falls back to the central Project directory.
There is no Project-authorization KV cache or lifecycle TTL.

Provisioning records the administrative Project directory and audit in the
control plane, then creates the shard-local authorization record before returning
success. An idempotent provisioning retry completes a missing shard write but
does not overwrite an existing record's ownership or lifecycle.

App deletion writes revocation tombstones to every configured
shard before committing the control-plane deletion and invalidating App
authentication. Shards reject both existing Projects and authorization records
written later by concurrent provisioning. If deletion stops partway through the
shards, completed tombstones continue denying access; retry deletion to finish.
New shards must be initialized consistently before accepting Project traffic.

**Clean-cutover deployment:** migration `0011_platform_project_authorizations.sql`
creates the shard tables. Existing Projects are not backfilled and cannot be
authorized using central directory rows alone. This change assumes the planned
data reset and fresh Project provisioning. Apply shard migrations before deploying
the Worker. The control plane retains its directory for listing, quotas, and
administrative operations.

## Backend flow

Use `@moxt-ai/mobius-sdk/platform` with a Clerk token for the selected organization
to create an App. Pass the Clerk organization ID as `tenantId`. App
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
