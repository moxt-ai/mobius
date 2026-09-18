# Regional relay storage

The Cloudflare relay accepts storage resolvers so one Worker can serve multiple
D1 databases and R2 buckets. The host owns tenant placement and the allowlist of
bindings. Mobius owns its SQL, content format, and credential authorization.

`DatabaseResolver.resolve(sharding)` synchronously selects a core `SqlDatabase` executor from an
already-resolved `TenantShardResolution`. `BucketResolver.resolve(sharding)` does
the same for R2. Neither resolver discovers identity or looks up placement.

`TenantShardingDirectory.resolve(tenantId, signal)` resolves placement using only
the tenant ID and returns a `TenantContext`. Requests that start with a pairing,
channel, or project credential first use the internal core pairing identity service.
Its storage searches the configured SQL candidates using the supplied
credential and requires a unique tenant/database match. The pairing service then
resolves that tenant's placement and verifies the selected database matches the
authenticated record before executing the operation.

The bootstrap owner credential is also stored in
`project_owner_credentials`. Project-scoped Runtime pairing and revocation
resolve this explicit credential rather than depending on a particular paired
Channel remaining online or active. New Runtime pairings retain the already
authorized Project and create no new owner credential. Pairing-code,
daemon, Runtime, and Channel authority remain independent per machine.

An authenticated embedding host creates a workspace pairing through the Project
pairing service. This direct-host composition builds pairing services without HTTP
dependencies. Standalone storage uses single-binding storage resolvers; Platform
resolves storage from the globally unique Project ID.

Bot owner, connector, execution, and grant credentials are authenticated against
the configured identity databases before placement is resolved. Bot storage is
constructed from the resulting `TenantContext` and `DatabaseResolver`; there is no
fixed Bot database option. Invalid credentials are rejected before placement lookup,
and unavailable placement is reported as a service failure rather than a credential
failure.
Pairing storage also receives a resolved `TenantContext`. The pairing identity
service authenticates before placement, then requires the resolved database to
match the credential's identity source. Composition constructs these services and
storages; it contains no credential or request-to-tenant orchestration.

`R2ContentStore` resolves placement by tenant ID before selecting the bucket for
each content operation, and accepts a host-owned key prefix
for shared buckets. Content keys retain tenant, project, session, and content IDs.
The resolver must reject missing or invalid placement rather than select a default.

The core remote session service resolves SQL storage for directory and quota operations;
`CloudflareSessionTransport` only addresses and sends requests to Durable Objects.
`RuntimeRelay` receives the same resolver for WebSocket credential checks
and session activity. `SessionRelay` receives an immutable content store;
regional hosts supply `R2ContentStore` with their bucket resolver. These dependencies
remain explicit and do not require mutable active-shard state.

`packages/relay-cloudflare-standalone` owns the standalone Worker entry point,
Wrangler profiles, and `StandaloneTenantShardingDirectory`. Its composition uses `SingleDatabaseResolver` and
`SingleBucketResolver` for the existing D1 and R2 bindings. Its Lite profile keeps
the Durable Object content store. Changing a host's binding or placement does not
migrate existing D1 rows, R2 objects, or Durable Object state.
