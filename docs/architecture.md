# Architecture

Mobius is a remotely accessible ACP client runtime with a portable Relay core,
a Cloudflare deployment profile, and a locally enforced security boundary.

```text
Pairing page / channel Web app / external connector
  -> TypeScript SDK (HTTP resources + Session SSE + Bot API)
  -> Relay API + ChannelActor + Bot control/data planes
  -> verified Tenant / Project scope
  -> Runtime / Channel connection owner
  -> independent Session runtime and query directory
  -> immutable execution-content archive
  -> paired Local Daemon
  -> verified local Agent catalog + execution authorization
  -> ACP v1 over JSON-RPC and stdio
  -> discovered built-in Agent CLI + optional ACP adapter
```

`packages/relay-core` owns inferred Hono feature route factories, orchestration services,
gateway contracts, input validation, pairing and channel contracts, the
platform-independent `ChannelActor`, and ports for content storage and peers.
Pairing, channel, session, and Bot logic is grouped by feature under `service/`.
Shared values, credentials, records, and codecs live under `entity/`; SQL and
content persistence contracts live under `infra/`. Storage must not import services,
HTTP routes, DI, application gateways, or platform adapters, including through
type-only imports or package barrels. Shared lower-layer modules follow the same
dependency direction.
Storage methods expose semantic persistence operations, including atomic SQL
batches and transactions. Services own authorization, lifecycle decisions,
revision planning, credential lifetimes, replay handling, and orchestration.
Bot target authorization is shared by HTTP submission and runtime recovery;
conversation provisioning and recovery use the same core conversation service.
Bot credential authentication searches the configured identity databases before
resolving tenant placement. Composition supplies Bot storage with the resolved
`TenantContext` and database resolver; HTTP Bot configuration has no fixed database.
Bot session storage atomically commits turn/execution/capability records, outbound
requests with usage accounting, and settlement with capability revocation and
completion delivery. Services prepare these operations and interpret persistence
results. Archive publication and session creation/deletion likewise have dedicated
atomic storage operations.
Session imports use a typed import plan: services validate terminal interactions
and artifact ownership, while storage serializes and restores the records and
archive work in one transaction. Failed imports use a dedicated atomic rollback.
Event projection services likewise prepare typed changes without writing SQL.
Event storage rechecks the planned session/source sequence, then commits the
projection, archive work, event, and sequence advance together. Core DO services
do not receive SQL executors; the core service tree has no transaction callbacks.
Bot failures carry typed domain codes and failure categories. HTTP boundaries
own the status mappings, including distinctions between missing and inaccessible
resources. Bot delivery failures likewise expose typed codes without HTTP status
fields in the service layer.
Portable SQLite persistence lives under `storage/`, while shared HTTP boundary
code lives under `infra/`.
The core content service verifies digests and handles immutable-write conflicts
and quota results. SQLite performs atomic usage checks and insertion; the R2
adapter selects the tenant bucket and executes conditional object writes. Neither
adapter performs content hashing or decides how conflicting content is handled.
R2 operations have an owned 15-second deadline covering placement and object
access. Timeout is reported as `content_storage_timeout`; caller cancellation
retains its original reason. Body streaming propagates cancellation, and both
R2 and D1 adapters release their deadline timers when operations settle.
`createMobiusApplication()` builds the reusable, chained route graph with a validated
API prefix. `createRelayDependencies()` accepts caller-created gateways and builds
a plain readonly context. Constructors declare only their required `services`,
`storages`, `gateways`, or `config` subset; HTTP routes read the request's context.
`src/di/` exposes two composition functions: `createRelayDependencies()` for HTTP
services and direct host pairing, and `createDurableObjectDependencies()` for the
shared runtime, session, and Bot delivery context. Helpers are private. Both
factories construct core storage and services from platform ports; the DO context
has a top-level `doDatabase` and no DO-kind selector. Pairing routes call
pairing services. Project-scoped revocation composes atomic directory lifecycle
changes with targeted Runtime disconnection. There is no
container, registration metadata, or application subclass. Core imports no
Cloudflare API. The actor validates protocol
messages, selects the one active daemon, routes commands, and commits reliable
session events before acknowledging them.
One Runtime uses one multiplexed daemon WebSocket for all of its Sessions. The
Runtime ingress scheduler preserves order within each Session while allowing up
to eight independent Session lanes to commit concurrently; heartbeats bypass
that queue. The connection admits at most 512 scheduled daemon messages, so an
overloaded daemon reconnects and replays from durable state instead of growing
Relay memory without bound. A terminal event failure is rejected for that event
without closing the shared Runtime connection, so another Session can continue.
Runtime disconnect cleanup persists its intent and per-session progress. Alarms
and reconnects resume unfinished cleanup after cancellation or a handler deadline;
completed sessions are not disconnected again when recovery resumes.
`SqliteSessionRuntime` owns atomic command deduplication, attempt transitions,
monotonic event sequencing, paginated query projections, retention, deletion,
and recoverable archive work.

`packages/relay-cloudflare-standalone` is the standalone composition root, using
the shared adapters in `packages/relay-cloudflare`. Core pairing storage uses the
D1 SQL executor for the daemon token hash, machine metadata, and locally
advertised agent catalog. Ready Agent entries include output-only executable
path and version metadata together with capability booleans normalized from a
bounded, successful ACP readiness probe. Persisted pre-capability catalogs are
read conservatively with every capability disabled. A Runtime Durable Object owns WebSocket
connections, and each independent session maps to a child Session Durable
Object with its own SQLite state. D1 is a rebuildable session query directory
and atomically reserves configured tenant/project session quota, while R2 stores
immutable compressed archive segments. D1 schema changes are applied by
Wrangler migrations before local development and after provisioning a
deployment; request handlers do not create infrastructure tables.
The Worker creates its application once at module scope and constructs dependencies
from the current bindings for each request. Durable Objects retain their owned
session resources for their instance lifetime.

One Project can contain up to eight active Runtime pairing records. Each record
owns one Runtime, one Channel, one daemon credential, and one independently
addressed Runtime Durable Object. `project_owner_credentials` keeps Project
administration independent of those Channel lifecycles, including after the
bootstrap Runtime is revoked. Idempotent Project-scoped pairing allocates the
first free bounded Runtime slot; `runtime_pairing_audit_events` records requested,
claimed, expired, revoked, and rejected outcomes. Revocation changes only the
selected record and asks only its Durable Object to close matching sockets.

For Cloudflare deployment, the Web build is uploaded as Worker Static Assets in
the same deployment as the Relay. API and WebSocket requests continue into the
Worker, while browser assets are served at the Worker origin. The browser derives
the relay WebSocket URL from that origin. The single current Relay API is exposed
under `/mobius/api`; it has no format or route-version branches. A bare origin
renders the pairing page.
The public TypeScript client uses HTTP for finite resource operations and one
authenticated Server-Sent Event stream for ordered Session events. The
capability document declares API version `1`, SSE event name
`mobius.session-event.v1`, and event payload format version `1`. A subscriber is
registered before cursor catch-up, so events committed during history reads are
merged without a gap. Per-subscriber buffering and client reconnects are
bounded, and heartbeat/liveness deadlines release abandoned streams.
A successful one-time claim gives the browser an independent
`/channels/<channel-id>` route. The Web application reads the paired machine and
agent catalog from D1 through the Relay whenever that route opens, so it works in
any browser that holds a scoped high-entropy host credential. The pairing browser
is the credential owner: it can mint a ten-minute, single-use access grant whose
secret is carried only in a URL fragment. Redeeming that grant atomically creates
a distinct linked-device credential; the grant secret and host credentials are
stored only as hashes. Linked devices cannot delegate access. The owner can list
and revoke each one independently, and revocation closes matching live sockets as
well as rejecting later HTTP and WebSocket authorization. The channel ID is only
an address and does not grant access. Mobius does not implement sign-up or
user/team policy. A deployment may register provider-neutral OIDC
authentication, but external issuer/subject verification becomes Project
authority only through an explicit server-owned grant; organization and role
claims never select a Tenant or Project by themselves.

Project-facing owner, browser, exchanged external, and application credentials
all produce the same readonly `ProjectAccessContext` with exact scope,
permissions, lifetime, credential ID, and audit actor. Runtime daemon and Bot
Connection requests instead produce `RuntimeAccessContext` and
`BotConnectionAccessContext`. A Bot outbound action additionally requires an
`ExecutionPermit` derived from the authenticated Runtime and the matching
server-backed execution capability. See [Project authentication and credential
operations](project-authentication.md) for the complete trust-plane and threat
model.

Forward D1 migrations preserve existing pairing rows, backfill explicit owner
credentials and Runtime slots, and add indexed Project/Runtime lookup.

Session identity and durable history are independent of connection channels.
Turns and Attempts have explicit queued, running, waiting, terminal, or
indeterminate lifecycle states. The daemon writes validated events through a durable SQLite
outbox; Relay acknowledgements are emitted only after the authoritative event,
projection, and archive job commit. Reconnection retransmits the same event IDs,
so it repairs delivery without rerunning a command. Clients catch up with ordered
cursors, then consume the same committed-event envelope live.

Daemon-to-Relay replay is fair across event sources: the connection window is 16
events and 32 MiB, with at most four unacknowledged events from one source. Each
ACK advances only that source. The SQLite outbox admits 10,000 ordinary events or
128 MiB and reserves an additional 128 events or 8 MiB for terminal outcomes.
Once the reserved capacity is exhausted, the local execution boundary fails
admission explicitly instead of consuming unbounded disk.

For Relay-to-daemon PendingWork, a receipt-capable connection receives a
`runtime.delivery` envelope with a stable delivery ID. The daemon validates and
stores it in a bounded SQLite inbox before sending `runtime.delivery.received`;
only then does Relay mark PendingWork complete and return
`runtime.delivery.committed`. Either side can reconnect between those steps and
repeat the same ID without rerunning completed work. Relay keeps at most 16
deliveries or 16 MiB in flight, while the daemon inbox holds at most 64 deliveries
or 64 MiB. Daemons that do not advertise delivery receipts retain the previous
send-compatible behavior during a rolling upgrade.

Public Turn submission names a Session, content, and an idempotency key. Relay
loads the server-owned Session binding, reauthorizes its exact Runtime, commits
the Turn, and only then requests dispatch. BotConversation uses this boundary as
a one-to-one Session extension: its immutable behavior and approved binding
revisions are pinned before a turn is accepted, while Session remains the
execution-history aggregate. Bot is the durable identity; Channel and
BotConnection are access paths, and Agent remains a local execution capability.

Bot directory and connection metadata live in D1. Each Session Durable Object
is the single writer for one Bot conversation's turns, executions, capability
records, and accepted outbound requests. Each BotConnectionActor is the single
writer for its ordered outbound delivery stream. Interrupted conversation
provisioning and outbound forwarding are idempotent sagas with reconciliation,
so valid inbound work may wait for a disconnected Runtime and accepted outbound
work may wait for a disconnected connector. See [Bots and external
connectors](bots.md) for the identity, authorization, API, and threat-model
contract.

Activity summaries are bounded separately from recorded details. Full permitted
details are captured before summarization, split into bounded compressed segments,
and loaded only when a user expands an activity. Archive manifests are published
only after all immutable segments pass integrity checks; hot content remains
queryable until that commit. Failed jobs survive restart and apply explicit
backpressure when their bounded queue is full.

Every session operation receives Tenant / Project from verified credentials.
Recording level, retention, hot event capacity, detail size, and active-session
quota are explicit policies. The single current export format contains
authoritative Turns, Attempts, Interactions, receipts, bindings, retained
committed events, bounded projections, and integrity-checked content;
imports validate the complete schema and never copy credentials. Deletion removes
hot rows, indexes, manifests, and archived objects before publishing a terminal
deleted lifecycle.

The daemon owns local path resolution, authorization, sandboxing, process
lifecycle, long-lived ACP conversation sessions, approved agent selection,
ACP integration installation, and audit records. Remote input is never an
authorization decision at the local execution boundary. Agent identifiers map
only to built-in local specifications; remote clients cannot provide commands,
URLs, versions, arguments, environment values, or executable paths. Paths and
versions sent in the catalog are output-only metadata and never become execution
authority when returned by a client.

## Local Agent catalog and integration trust boundary

Discovery resolves an exact Agent/adapter pair from explicit local overrides,
direct platform-aware `PATH` lookup, or Mobius's private managed cache. It
resolves symlinks, verifies executable regular files, captures stable file
identity, runs each Agent's fixed bounded version probe, supplies the resolved
Agent path to the adapter, and completes a bounded ACP initialize handshake. Pi
uses `PI_ACP_PI_COMMAND` to bind the verified executable and must also finish a
bounded `/session` prompt through `pi-acp -> pi --mode rpc`. The resulting
candidate pair is accepted only after the complete probe. Cursor CLI, Grok Build,
and WorkBuddy use native ACP entrypoints and must create a session during
readiness probing. Besides `PATH`, an Agent specification can contribute fixed
local installation candidates. WorkBuddy uses this boundary to discover the
embedded `codebuddy` executable from standard macOS `WorkBuddy.app` locations
without accepting an application path from a remote client. An invalid automatic
external candidate can fall back to the private cache, while an explicit override
never silently falls back. Before each new adapter process, both identities are
revalidated; a changed runtime is rejected without touching an existing
conversation.

Pairing and daemon startup perform only read-only discovery:

```text
supported Agent ID + no verified Agent executable
  -> agent_not_installed

supported Agent ID + verified Agent executable + incomplete ACP path
  -> integration_not_installed + Agent path + Agent version

supported Agent ID + verified Agent executable + complete ACP probe
  -> ready + Agent path + Agent version
```

No Agent or adapter package is installed automatically. Pairing claims and the
standalone `agents` diagnostic remain read-only. After startup, the catalog
changes only after an explicit, verified integration request. Ordinary
discovery or verification failure leaves the daemon and channel online.

The ready and installable catalogs are separate contracts. The daemon publishes
IDs and labels for every supported Agent plus the discovered path and reported version for
each detected Agent through a daemon-token-authenticated endpoint before opening
its WebSocket. A runtime online event tells Web to refetch the descriptor. Zero
ready Agents is valid because missing Agents remain visible as status entries.
The owner and any linked channel device can read the published path and version;
adapter paths, file identities, launch environments, raw probe output, and
credentials are not published.

Web presents the same contracts on the channel Agent settings route. Ready
entries show Agent version and path and link back to chat. Setup entries show
either `Not installed` or the detected Agent details, and can request, retry, or
cancel integration installation. This is integration management, not remote
Agent package management: Agent installation, removal, upgrades, sign-in, and
provider credentials stay outside the Web action surface.

Integration installation follows the local execution-boundary pipeline:

```text
requestId + registered agentId from Web
  -> strict integration-specific protocol validation
  -> local Agent ID authorization against the built-in catalog
  -> fresh local executable and version discovery
  -> agent_not_installed when no verified Agent exists
  -> pinned private ACP adapter staging for bridged Agents only
  -> normal Agent and ACP discovery
  -> authenticated catalog publication
  -> local audit event
```

The Relay authenticates and routes integration messages but never executes them.
The integration-specific message kinds are distinct from the former Agent
installation protocol, so mixed old and new clients cannot silently turn this
button into an Agent installer. A Web click confirms one request; the local
daemon remains the final authority and rejects any Agent ID outside its built-in
catalog. The host credential cannot provide or alter an executable, command,
version, URL, argument, environment value, or target. Adapter installer
processes receive a minimal allowlisted environment with no channel token, Agent
credential, or unrelated Mobius variable. Temporary directories, subprocess
trees, output buffers, overall deadlines, and one-job per-Agent concurrency
slots are owned and released by the local daemon.

Managed adapters use exact package versions, omit optional platform Agent
dependencies, disable lifecycle scripts, validate package name/version/bin
containment in a staging directory, and publish with an atomic rename. A failed
adapter staging install cannot replace an existing cache entry. Direct ACP
Agents do not stage an adapter and only repeat the full local readiness probe.
Previously cached Agent executables may still be discovered and revalidated,
but this workflow never creates or replaces them. Integration request IDs are
idempotent for the daemon lifetime, and all cross-Relay progress and failure
events use bounded stages and sanitized stable codes.

## Workspace ownership

- `packages/relay-core` owns the portable Relay routes, services,
  gateways, channel behavior, domain contracts, and runtime/storage ports.
- `packages/relay-cloudflare` owns the D1 implementation, Runtime and Session
  Durable Objects, R2 adapter, and Cloudflare migrations.
- `packages/relay-cloudflare-standalone` owns the standalone Worker entry point,
  single-binding resolvers, Wrangler deployment profiles, and Worker Assets composition.
- `packages/cli` is the publishable `@moxt-ai/mobius` CLI and owns its local daemon,
  execution boundary, and ACP client integration.
- `packages/protocol` owns messages shared across process and network
  boundaries.
- `packages/web-sdk` owns the public provider-neutral Bot connector client as
  well as the Session resource client.
- `packages/web` owns the Vite application shell, runtime dependencies, and
  Tailwind CSS entrypoint.
- `packages/web-core` owns the reusable React agent experience, including chat
  and integration components.
- `packages/web-sdk` owns the browser-and-Node TypeScript resource API and the
  browser channel-control transport used by the built-in Web application.
- `e2e/fixtures` contains deterministic external-boundary fixtures.
- `deploy/docker` is an empty placeholder for a future packaged Node image.

Cloudflare is therefore a deployment profile rather than a core dependency. The
current product provides only the Cloudflare profile. Node adaptation, a
packaged Node server, a Docker image, multi-process channel ownership, leases,
and fencing remain intentionally deferred.
