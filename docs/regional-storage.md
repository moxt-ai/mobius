# Regional relay storage

The Cloudflare relay accepts storage resolvers so one Worker can serve multiple
D1 databases and R2 buckets. The host owns tenant placement and the allowlist of
bindings. Mobius owns its SQL, content format, and credential authorization.

`DatabaseResolver.resolve(sharding)` synchronously selects a D1 database from an
already-resolved `TenantShardResolution`. `BucketResolver.resolve(sharding)` does
the same for R2. Neither resolver discovers identity or looks up placement.

`TenantShardingDirectory.resolve(tenantId, signal)` resolves placement using only
the tenant ID and returns a `TenantContext`. Requests that start with a pairing,
channel, or project credential first use `PairingIdentityDirectory.authenticate`.
Its D1 implementation searches the configured candidates using the supplied
credential and requires a unique tenant/database match. The pairing gateway then
resolves that tenant's placement and verifies the selected database matches the
authenticated record before executing the operation.

An authenticated embedding host creates a workspace pairing with
`D1PairingGateway.createPairing(tenantId, signal)`. The tenant ID must come
from the host's verified identity context. Standalone deployment uses the upstream
`ConfiguredPairingTenantResolver` with an explicit `MOBIUS_TENANT_ID` and rejects
pairing when it is missing. Pairing never generates tenant identities. Standalone
storage composition supplies a tenant directory returning `{ hasShard: false }`
and single-binding storage resolvers.

`R2ContentStore` resolves placement by tenant ID before selecting the bucket for
each content operation, and accepts a host-owned key prefix
for shared buckets. Content keys retain tenant, project, session, and content IDs.
The resolver must reject missing or invalid placement rather than select a default.

`CloudflareSessionRuntime` resolves D1 for directory and quota operations.
`RuntimeRelay` receives the same resolver for WebSocket credential checks
and session activity. `SessionRelay` receives an immutable content store;
regional hosts supply `R2ContentStore` with their bucket resolver. These dependencies
remain explicit and do not require mutable active-shard state.

`packages/relay-cloudflare-standalone` owns the standalone Worker entry point,
Wrangler profiles, and `StandaloneTenantShardingDirectory`. Its composition uses `SingleDatabaseResolver` and
`SingleBucketResolver` for the existing D1 and R2 bindings. Its Lite profile keeps
the Durable Object content store. Changing a host's binding or placement does not
migrate existing D1 rows, R2 objects, or Durable Object state.
