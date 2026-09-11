# Mobius Platform Integration Lab

After this, a developer can launch one local application, provision the Mobius
Platform control plane, pair the production Runtime SDK, and see evidence from
each supported trust plane without exposing an AppCredential to the browser.

## Run

From the repository root:

```bash
pnpm demo:platform
```

Open the URL printed by the command. The managed worktree's Relay and Web ports
are reused, so parallel Mobius worktrees remain isolated. A repository-level
supervisor applies both local D1 migration streams, starts the development-only
Platform host, API backend, and Vite frontend, and stops all three on `Ctrl-C`.

The application package never imports Relay Core or a Cloudflare hosting
implementation. Its trusted backend calls `@moxt-ai/mobius-sdk/platform` and
`@moxt-ai/mobius-sdk/server`; its browser calls only
`@moxt-ai/mobius-sdk/browser`. The local host belongs to
`@moxt-ai/mobius-relay-cloudflare-platform` and is launched beside the app only
to make this repository demo self-contained.

The Runtime stage prints a one-time `pnpm mobius pair` command. Run it from the
repository root in a second terminal and keep it open while exercising Bot and
Conversation operations. The pairing uses `@moxt-ai/mobius/runtime`, local Agent
discovery, the authenticated Runtime WebSocket, and the normal execution-boundary
approval flow.

Local Platform, Runtime, and workspace state is written only below
`.demo-platform-state/`, `.demo-runtime-state/`, and `demo-workspace/`; every
path is ignored by Git. The generated pairing command carries the isolated
Runtime state directory explicitly.

## Verified boundaries

| Stage | Executed behavior | Browser-visible secret |
| --- | --- | --- |
| Platform | Health, hosting profile, Tenant, App, Project, directory reads, quota usage, audit events | None |
| AppCredential | Scoped issue, authenticated use, rotation, overlap metadata, revocation, post-revocation denial | None |
| Runtime | Pairing creation and status, Runtime registration, Agent inventory, online presence, authenticated WebSocket | Pairing code only |
| Bot | Create/read/list, profile revision, behavior revision, execution binding, local approval | None |
| Conversation | Create/list and server-issued fixed-session access | Short-lived `mconv_...` credential |
| Browser SDK | Session snapshot, configuration, Artifact upload/read/download, history, events, messages, Turns, pending Interactions | The fixed Conversation credential |

The full Platform integration suite additionally owns negative authorization,
cross-App isolation, quotas, event-stream revocation, cursor pagination,
multi-Runtime independence, configuration dispatch, Turn cancellation, and
connector contracts:

```bash
pnpm test:integration:platform
pnpm test:integration:platform-demo
```

The separate local Platform host uses an explicit development-only authenticator
with a random process-lifetime token and binds only to `127.0.0.1`. Production
Platform hosting continues to require the configured OIDC/JWKS path documented in
[`docs/platform-hosting.md`](../../docs/platform-hosting.md).
