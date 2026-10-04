# Mobius

## Why Mobius exists

People already do useful work with coding Agents on their own computers. Their
projects, tools and ongoing conversations are there, but checking progress or giving
the next instruction should not require sitting in front of that computer.

Mobius makes those Agents available remotely. Users can keep working with their
existing projects and conversations from another device. Developers building Agent
applications can offer that experience without solving remote access and conversation
continuity separately for every supported Agent. Users can also use Mobius on its
own; Morty is one application built on it.

## Functional value

| User need | What Mobius should make possible |
| --- | --- |
| Work away from my computer | Connect my machine and use its Agents remotely, with access to the projects and tools already there. |
| Continue work already started | Find and resume an available conversation instead of explaining the task again in a new chat. |
| Stay in control of ongoing work | See progress, give the next instruction, queue follow-up work, stop work or answer a request for permission. |
| Move between devices | Open the same conversation elsewhere and catch up on both my instructions and the Agent's output. |
| Use the results | Read available history and view authorized files and images produced by the Agent. |
| Choose cloud history retention | Use local history, or explicitly enable cloud recording when history needs to remain accessible without the local machine. |

These are product requirements. Availability depends on the selected Agent and
configuration; unsupported operations must be clear to the user. Implementation and
[verification evidence](TESTING.md) determine which scenarios are supported today.

## Non-functional requirement: efficient current-turn streaming

Users should see new output promptly throughout a turn, even as the answer grows.
Streaming must not become progressively slower because earlier output is repeatedly
copied and processed.

During a continuous subscription, each update must carry the new or changed content
rather than a complete copy of the accumulated turn. Copying, serialization, transport
and client processing must avoid repeatedly traversing the whole turn for each update.
For a fixed number of observers, total streaming work should grow with the content
produced, not with the sum of every successively larger full-turn snapshot.

A complete current-turn view may be needed when a client first joins or recovers after
an interruption. That recovery cost must not be paid again for every streaming update.
This requirement does not prescribe a particular patch format or cursor algorithm.

## Data ownership and recovery

Users must know when their machine needs to be online and where conversation content
is retained. Without cloud recording, history depends on the connected machine and
what its Agent has saved. Optional cloud recording provides history according to the
configured retention policy; it does not keep an offline Agent running.

The current product also stores session metadata and pending delivery content locally,
so disabling cloud recording does not mean that nothing is written on the machine.
Restarting the daemon does not automatically resume running work or queued prompts.
See [current persistence behavior](DEVELOPMENT.md#current-persistence-behavior) for the
technical disclosure and implementation references.

## Product boundary

Mobius provides remote access to existing Agents. It does not replace their model,
tools or native work environment, and it cannot make an unsupported Agent operation
available merely by exposing it in a client.

[Morty (Mobius Chat)](https://github.com/moxt-ai/morty) provides the ready-to-use Bot
and browser chat experience. Applications remain responsible for deciding who may
access their conversations; local actions must still be authorized on the machine.

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
Runtime discovery, Session history, and Session operations. The browser persists the
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
