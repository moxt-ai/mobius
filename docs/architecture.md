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
Pairing, channel, and session logic is grouped by feature under `service/`;
Valibot schemas and inferred persisted-record types live under `entity/session/`.
Storage methods expose semantic persistence operations, validate database results
with these schemas, and execute one SQL statement each. Services own validation,
lifecycle decisions, transaction boundaries, and multi-step composition.
Portable SQLite persistence lives under `storage/`, while shared HTTP boundary
code lives under `infra/`.
`createMobiusApplication()` builds the reusable, chained route graph with a validated
API prefix. `createMobiusDependencies()` accepts caller-created gateways and builds
a plain readonly context. Constructors declare only their required `services`,
`storages`, `gateways`, or `config` subset; HTTP routes read the request's context.
`createSessionDependencies()` constructs schema-backed storages and session services
in dependency order. Pairing routes use the pairing gateway directly. There is no
container, registration metadata, or application subclass. Core imports no
Cloudflare API. The actor validates protocol
messages, selects the one active daemon, routes commands, and commits reliable
session events before acknowledging them.
`SqliteSessionRuntime` owns atomic command deduplication, attempt transitions,
monotonic event sequencing, paginated query projections, retention, deletion,
and recoverable archive work.

`packages/relay-cloudflare` is the active composition root. D1 implements the
pairing gateway and stores the daemon token hash, machine metadata, and locally
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

`packages/relay-node` supplies the same public Relay API composition with a
single SQLite database and a containment-checked local filesystem content store.
The embedding process supplies its pairing and channel gateways and HTTP
listener. The Node and Cloudflare profiles share the session gateway contracts
and are exercised by matching public API scenarios. `NodeSessionRuntime` and
`CloudflareSessionRuntime` implement those contracts directly without adapter
wrappers.
Node creates a stable application context for its runtime lifetime and closes
event streams and its database through the returned `close()` operation.

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
an address and does not grant access. Mobius deliberately has no user identity
system; user and team policy belongs in a separate identity service layered over
these capabilities.

The credential tables are part of the rebuilt initial D1 schema. A D1 instance
created by an earlier revision must be reset once when adopting this design.

Session identity and durable history are independent of connection channels.
Turns and Attempts have explicit queued, running, waiting, terminal, or
indeterminate lifecycle states. The daemon writes validated events through a durable SQLite
outbox; Relay acknowledgements are emitted only after the authoritative event,
projection, and archive job commit. Reconnection retransmits the same event IDs,
so it repairs delivery without rerunning a command. Clients catch up with ordered
cursors, then consume the same committed-event envelope live.

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
- `packages/relay-cloudflare` owns the Worker entry point, D1 implementation,
  Runtime and Session Durable Objects, R2 adapter, Cloudflare migrations, and
  Worker Assets composition.
- `packages/relay-node` owns the single-instance Node composition, SQLite adapter,
  and local filesystem content adapter.
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
repository also provides the embeddable single-process Node profile. A packaged
Node server, Docker image, multi-process channel ownership, leases, and fencing
remain intentionally deferred.
