---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Mobius

## Why Mobius exists

People already do useful work with coding Agents on their own computers. Their
projects, tools and ongoing conversations are there, but checking progress or giving
the next instruction should not require sitting in front of that computer.

Mobius makes those Agents available remotely. From another device, users can find and
resume available conversations, give instructions, queue follow-up work, stop execution,
answer permission requests and view results, including files and images. Developers
can offer this experience without implementing remote access separately for each
Agent. Mobius can be used on its own through its SDK and Relay. Its bundled Web app
provides pairing, Runtime management and Agent configuration; it does not provide a
second chat product. [Morty](https://github.com/moxt-ai/morty) provides the Bot and
browser chat experience, including conversations, live replies and history.

Ongoing work should feel like a live broadcast. Multiple devices can watch the same
conversation and see instructions sent from elsewhere. Publishing continues when
nobody is watching. New output should arrive promptly as the answer grows: ordinary
updates carry new or changed content, so processing and transfer grow with the content
produced rather than with repeated copies of the entire turn. Joining or reconnecting
may require a full current-turn view, but that catch-up cost must not recur on every
update.

We choose responsive live output and a simple lifecycle over guaranteed delivery.
Disconnected or overloaded viewers can miss events, and daemon or Relay restarts can
lose in-flight messages. Reconnecting resumes the broadcast; users catch up through
the available current-turn view, native Agent history or cloud recordings. Restarting
the daemon does not resume running work or queued prompts.

Users can choose optional cloud Recording when history needs to remain accessible
without their machine. Recording is best effort: it retains what it successfully
receives, and slow writes, failures or restarts can leave gaps. It must never block
live output, and failed writes are not retried. It is not a lossless audit archive and
does not keep an offline Agent running.

Mobius reuses each Agent's model, tools and native environment. Available operations
depend on that Agent and the configuration; unsupported capabilities must be clear.
Applications decide who may access conversations, and local actions must still be
authorized on the user's machine.

## Data ownership and recovery

Without cloud Recording, history depends on the connected machine and what its Agent
has saved. Recording retains cloud history according to the configured policy.

Pairing and session metadata may be stored locally, and Agents manage their own native
history. Current-turn content and pending work must remain in daemon memory;
restarting the daemon loses them. Disabling Recording does not erase Agent history
or local metadata. See [persistence and recovery constraints](DEVELOPMENT.md#persistence-and-recovery-constraints).

Images should be fetched from the connected machine when needed, so large embedded
images do not delay the conversation. Temporary image files are a disposable media
cache, not saved conversations; their availability depends on the connected machine
and retained Agent history. See [image delivery constraints](DEVELOPMENT.md#image-delivery-constraints).

## Local development

Use Node and pnpm versions from `.nvmrc` and `package.json`.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` starts the local Platform Worker. Committed migrations under `packages/*/migrations` define fresh local databases; `pnpm db:codegen` generates ignored SQL import modules used by the Worker and tests.

## Standalone Worker

Standalone runs the Relay without the Platform control plane. Each browser pairing
workflow automatically creates a Project and a Project owner credential. A separate
deployment-owned bearer credential can administer every Project. Generate the deployment credential and start it locally:

```sh
printf 'MOBIUS_STANDALONE_TOKEN=%s\n' "$(openssl rand -hex 32)" > packages/relay-cloudflare-standalone/.dev.vars
pnpm dev:cloudflare:standalone
```

The local command applies the committed D1 migration before starting Wrangler. The
credential file is ignored by Git. The bundled Web app never receives this deployment
credential. Its deployment adapter creates a Project and its Project-scoped owner
credential, then uses the generic `MobiusClient` for Runtime pairing,
Runtime discovery and management, and Agent configuration. Conversation operations
remain available to SDK clients such as Morty. The browser persists the
Project credential after pairing so page loads and WebSocket reconnects return to the
same Project.

For an operator-driven pairing, first send `POST /mobius/api/v1/standalone/projects`
to create a Project, then send `POST /mobius/api/v1/projects/{projectId}/runtime-pairings`
with either its returned Project credential or the deployment credential and
`{"idempotencyKey":"my-machine"}`.

```sh
curl -sS -X POST http://127.0.0.1:8787/mobius/api/v1/standalone/projects

curl -sS -X POST http://127.0.0.1:8787/mobius/api/v1/projects/<projectId>/runtime-pairings \
  -H "Authorization: Bearer <projectToken>" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"my-machine"}'
```

The response supplies `pairingId` and `pairingCode` for the existing CLI:

```sh
pnpm mobius pair --url http://127.0.0.1:8787 --pairing <pairingId> --code <pairingCode>
```

Operator clients can use the same deployment credential for Project and Session API
requests. Keep it private: it grants full access to every Standalone Project. Browser
apps should follow the bundled Web app and keep the Project credential inside their
deployment integration. The SDK's WebSocket transport is available at `/mobius/api/v1/transport`.
A connected local Runtime supplies Session history when Recording is disabled. When
Recording is installed and enabled for a Standalone Project during pairing, the Web
app loads that Project's durable history from Recording instead. The Standalone Worker
acts as one deployment-owned Platform principal, but does not expose the hosted
Platform's identity, App, or organization control-plane routes.

The repository deploys the production Standalone Worker to
`https://mobius-standalone.moxt.ai` after `main` passes CI. The workflow deploys
the Worker and Web assets with the `MOBIUS_STANDALONE_TOKEN` GitHub environment
secret and verifies the deployed page. Before deploying the Worker, CI applies
the committed `packages/relay-cloudflare-standalone/migrations/d1` migrations to the dedicated
production D1 database with the D1 Edit-only `CLOUDFLARE_D1_API_TOKEN`
environment secret and stops the deployment if migration fails.
Self-hosted deployments need their own bearer credential and D1 binding.

## Local Runtime connections

Pairing starts or reuses one detached Mobius manager for the current user. If the
installed CLI version changes, the next `mobius pair` or `mobius start` command
stops the old manager and launches the matching version.

Run `mobius start` without options to ensure the detached daemon is running.

Manage saved Runtime pairings by their local Connection ID:

```bash
mobius pair list
mobius pair list --output-json=/path/to/existing-file.json
mobius pair stop --connection <connection-id>
mobius start
mobius start --connection <connection-id>
mobius pair remove --connection <connection-id>
mobius quit
```

Stopping preserves the pairing and its `stopped` status across manager restarts.
Starting resumes the same Connection ID, while removing deletes its local
credential. `mobius pair list` shows the Connection ID, Platform App ID, Runtime
ID, workspace, and current status. Channel IDs remain internal Relay routing
identities and are not accepted as local lifecycle selectors.

For machine-readable output, use `--output-json` with an existing file. The CLI
refuses to create the target; command help and executable scenarios define its output contract.

See [DEVELOPMENT.md](./DEVELOPMENT.md) and [TESTING.md](./TESTING.md).
