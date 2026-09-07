# Architecture

Mobius is a remotely accessible ACP client runtime with a portable Relay core,
a Cloudflare deployment profile, and a locally enforced security boundary.

```text
Pairing page / channel Web app
  -> Web SDK
  -> Relay API + ChannelActor
  -> verified Tenant / Project scope
  -> Runtime / Channel connection owner
  -> independent Session runtime and query directory
  -> immutable execution-content archive
  -> paired Local Daemon
  -> verified local Agent catalog + execution authorization
  -> ACP v1 over JSON-RPC and stdio
  -> discovered Codex or Claude Code adapter + Agent CLI
```

`packages/relay-core` owns the Hono HTTP routes, input validation, pairing and
channel contracts, the platform-independent `ChannelActor`, and ports for the
pairing directory, session runtime, content storage, peers, and deployment
runtime. It imports no Cloudflare API. The actor validates protocol messages,
selects the one active daemon, routes commands, and commits reliable session
events before acknowledging them. `SqliteSessionRuntime` owns atomic command
deduplication, attempt transitions, monotonic event sequencing, paginated query
projections, retention, deletion, and recoverable archive work.

`packages/relay-cloudflare` is the active composition root. D1 implements the
pairing directory and stores the daemon token hash, machine metadata, and locally
advertised agent catalog. A Runtime Durable Object owns WebSocket connections;
each independent session maps to a child Session Durable Object with its own
SQLite state. D1 is a rebuildable session query directory and atomically reserves
configured tenant/project session quota, while R2 stores immutable compressed
archive segments. D1 schema changes are applied by Wrangler migrations before
local development and after provisioning a deployment; request handlers do not
create infrastructure tables.

`packages/relay-node` supplies the same public Relay API composition with a
single SQLite database and a containment-checked local filesystem content store.
The embedding process supplies its pairing directory, channel transport, and
HTTP listener. The Node and Cloudflare profiles share the session domain contract
and are exercised by matching public API scenarios.

For Cloudflare deployment, the Web build is uploaded as Worker Static Assets in
the same deployment as the Relay. API and WebSocket requests continue into the
Worker, while browser assets are served at the Worker origin. The browser derives
the relay WebSocket URL from that origin. The single current Relay API is exposed
under `/api`; it has no Mobius format or route-version branches. A bare origin
renders the pairing page.
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
software installation, and audit records. Remote input is never an authorization
decision at the local execution boundary. Agent identifiers map only to the
built-in Codex and Claude Code specifications; remote clients cannot provide
commands, URLs, versions, arguments, environment values, or executable paths.

## Local Agent catalog and installation trust boundary

Discovery resolves an exact Agent/adapter pair from explicit local overrides,
direct platform-aware `PATH` lookup, or Mobius's private managed cache. It
resolves symlinks, verifies executable regular files, captures stable file
identity, runs bounded `--version` probes, supplies the resolved Agent path to
the adapter, and completes a bounded ACP initialize handshake. The resulting
candidate pair is accepted only after the complete probe: an invalid automatic
external candidate can fall back to the private cache, while an explicit
override never silently falls back. Before each new adapter process, both
identities are revalidated; a changed runtime is rejected without touching an
existing conversation.

Daemon startup includes one local-only adapter provisioning transition:

```text
supported Agent ID + structurally valid local Agent CLI + bounded version probe
  -> exact pinned ACP adapter staging in the private cache
  -> normal Agent and ACP discovery
  -> catalog transition only after a successful ACP initialize handshake
  -> local audit event
```

This path never installs an Agent platform binary and never runs when the user
has set an explicit adapter override. Cancellation crosses the complete
operation; an ordinary adapter installation or verification failure is recorded
and leaves the daemon online with the Agent unavailable. Pairing claims and the
standalone `agents` diagnostic remain read-only. After startup, the catalog
changes only after a verified local installation or recovery request.

The ready and installable catalogs are separate contracts. The daemon publishes
only IDs, labels, and whether a local confirmation is required through a
daemon-token-authenticated endpoint before opening its WebSocket. A runtime
online event tells Web to refetch the descriptor. Zero ready Agents is valid
when a supported fixed recipe is installable.

Web presents the same contracts on the channel Agent settings route. Ready
entries are view-only and link back to chat; installable entries can request,
retry, or cancel the fixed local workflow. This is catalog management, not
remote package management: Agent removal, upgrades, executable details, and
provider credentials stay outside the Web surface.

Installation follows the local execution-boundary pipeline:

```text
requestId + registered agentId from Web
  -> strict protocol validation
  -> built-in recipe and private target resolution
  -> per-request terminal confirmation or narrow local grant
  -> bounded official download, verification, and subprocess execution
  -> pinned private ACP adapter staging and atomic publication
  -> normal Agent and ACP discovery
  -> authenticated catalog publication
  -> local audit event
```

The Relay authenticates and routes installation messages but never authorizes or
executes them. The channel URL is a bearer capability and therefore cannot grant
software-installation authority. Installer processes receive a minimal
allowlisted environment with no channel token, Agent credential, or unrelated
Mobius variable. Downloads enforce TLS, approved initial and redirect hosts,
size and time limits, and a recorded SHA-256 digest. Vendor checksum or signature
checks remain active when the fixed vendor installer provides them. Temporary
directories, subprocess trees, output buffers, overall deadlines, and one-job
per-Agent concurrency slots are owned and released by the local daemon.

Managed adapters use exact package versions, omit optional platform Agent
dependencies, disable lifecycle scripts, validate package name/version/bin
containment in a staging directory, and publish with an atomic rename. A failed
staging install cannot replace an existing cache entry. Installation request IDs
are idempotent for the daemon lifetime, and all cross-Relay progress and failure
events use bounded stages and sanitized stable codes.

## Workspace ownership

- `packages/relay-core` owns the portable Relay API, channel behavior, domain
  contracts, and runtime/storage ports.
- `packages/relay-cloudflare` owns the Worker entry point, D1 implementation,
  Runtime and Session Durable Objects, R2 adapter, Cloudflare migrations, and
  Worker Assets composition.
- `packages/relay-node` owns the single-instance Node composition, SQLite adapter,
  and local filesystem content adapter.
- `packages/cli` is the publishable `@moxt-ai/mobius` CLI and owns its local daemon,
  execution boundary, and ACP client integration.
- `packages/protocol` owns messages shared across process and network
  boundaries.
- `packages/web` owns the Vite application shell, runtime dependencies, and
  Tailwind CSS entrypoint.
- `packages/web-core` owns the reusable React agent experience, including chat
  and integration components.
- `packages/web-sdk` owns the browser-facing API.
- `e2e/fixtures` contains deterministic external-boundary fixtures.
- `deploy/docker` is an empty placeholder for a future packaged Node image.

Cloudflare is therefore a deployment profile rather than a core dependency. The
repository also provides the embeddable single-process Node profile. A packaged
Node server, Docker image, multi-process channel ownership, leases, and fencing
remain intentionally deferred.
