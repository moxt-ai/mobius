# Architecture

Mobius is a remotely accessible ACP client runtime with a portable Relay core,
a Cloudflare deployment profile, and a locally enforced security boundary.

```text
Pairing page / channel Web app
  -> Web SDK
  -> Relay API + ChannelActor
  -> Cloudflare adapters: D1 + per-channel Durable Object
  -> paired Local Daemon
  -> ACP v1 over JSON-RPC and stdio
  -> Codex or Claude Code adapter
```

`packages/relay-core` owns the Hono HTTP routes, input validation, pairing and
channel contracts, the platform-independent `ChannelActor`, and ports for the
pairing directory, turn store, peers, and deployment runtime. It imports no
Cloudflare API. The actor validates protocol messages, applies turn transitions,
selects the active daemon, and broadcasts runtime and conversation events.

`packages/relay-cloudflare` is the active composition root. D1 implements the
pairing directory and stores the daemon token hash, machine metadata, and locally
advertised agent catalog. Each channel maps to a native Durable Object. Its
adapters provide WebSocket hibernation, peer lookup, and Durable Object SQL turn
storage to the shared actor. D1 schema changes are applied by Wrangler migrations
before local development and after provisioning a deployment; request handlers
do not create infrastructure tables.

For Cloudflare deployment, the Web build is uploaded as Worker Static Assets in
the same deployment as the Relay. API and WebSocket requests continue into the
Worker, while browser assets are served at the Worker origin. The browser derives
the relay WebSocket URL from that origin. A bare origin renders the pairing page.
A successful one-time claim gives the browser an independent
`/channels/<channel-id>` route. The Web application reads the paired machine and
agent catalog from D1 through the Relay whenever that route opens, so it works in
any browser. Browser access is intentionally based on the high-entropy channel
identifier in this phase; user and team authorization remain a required layer
before channels are shared outside a trusted group.

The daemon owns local path resolution, authorization, sandboxing, process
lifecycle, long-lived ACP conversation sessions, approved agent selection, and
audit records. Remote input is never an authorization decision at the local
execution boundary. Agent identifiers map only to the preconfigured official
Codex and Claude Code ACP adapters; remote clients cannot provide commands or
executable paths.

## Workspace ownership

- `packages/relay-core` owns the portable Relay API, channel behavior, domain
  contracts, and runtime/storage ports.
- `packages/relay-cloudflare` owns the Worker entry point, D1 implementation,
  Durable Object adapters, Cloudflare migrations, and Worker Assets composition.
- `packages/relay-node` is an empty placeholder for a future single-instance
  Node profile; it does not currently provide a server or storage implementation.
- `packages/cli` is the publishable `@moxt-ai/mobius` CLI and owns its local daemon,
  execution boundary, and ACP client integration.
- `packages/protocol` owns messages shared across process and network
  boundaries.
- `packages/web` owns the Vite, React, Zustand, Tailwind CSS, and shadcn/ui agent
  chat application.
- `packages/web-sdk` owns the browser-facing API.
- `e2e/fixtures` contains deterministic external-boundary fixtures.
- `deploy/docker` is an empty placeholder for the future `relay-node` image.

Cloudflare is therefore a deployment profile rather than a core dependency. The
current product still supports only that profile. Node, Docker, multi-process
channel ownership, leases, and fencing are intentionally not implemented yet.
