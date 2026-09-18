# Mobius

[![CI](https://github.com/moxt-ai/mobius/actions/workflows/ci.yml/badge.svg)](https://github.com/moxt-ai/mobius/actions/workflows/ci.yml)

The engineering-quality target is 100% across lines, statements, functions, and
branches, as an advisory target. CI uses `pnpm ci:check` for the complete verification suites,
reports combined production TS/TSX coverage, and enforces architecture constraints.
CI saves the three test groups' coverage maps as downloadable artifacts. See [Testing](TESTING.md)
for scope and commands.

## Project direction

Mobius is being built as a network layer for hosting, reaching, and operating
agents across your local and cloud machines. The planned product scope includes:

- **Host and connect** — Proxy network traffic to agents distributed across
  multiple local or cloud machines, manage their lifecycle, and expose them as
  network services that can be reached and invoked remotely.
- **Connect agents to external services** — External applications can register
  small system prompt contributions that tell an agent which service is
  available, where to discover its API, and how to call it. Mobius also provides
  the agent with a signed identity token through an environment variable. The
  agent can use that token to authenticate itself when it chooses to call an
  external service. Service discovery and agent identity are two parts of the
  same capability: enabling an agent to connect to and act in external services
  as itself. In the human world, Google provides accounts as an identity layer
  for people; Mobius provides the equivalent identity layer for agents.
  Third-party services must explicitly support and accept this token type.
- **Minimal and composable** — Mobius has few dependencies, can run on the free
  Cloudflare Workers plan, works on its own, and can be composed with external
  applications when needed.
- **Centralized LLM provider management (optional)** — Manage the LLM
  providers used by your agents from one place, making it easy to switch a
  coding-plan subscription or change the API server with a single action.

## Connecting agents to external applications

Mobius gives an agent two inputs for connecting to external applications: a
concise system prompt contribution for discovering the application and a signed
identity token exposed through an environment variable. The agent decides
whether to use the application and sends the request itself.

Mobius does not need to install a local tool or place a complete API schema in
an agent's context for every available application. An application instead
registers its prompt contribution with Mobius for the relevant tenant or agent.

For example, `app-slack` can register content that tells an agent:

- A Slack web service is available.
- Where that service and its detailed API documentation can be found.
- That requests must use an agent identity token issued by Mobius.

Mobius injects this contribution when it builds the agent's system prompt. The
agent then decides whether the capability is relevant. Only when needed does the
agent read the application's detailed API documentation, read its identity
token from the environment variable, and call the web service using an
available HTTP client such as `curl`. Mobius does not intercept or proxy the
request.

```text
app-slack ── registers prompt contribution ──> Mobius
                                                  ├── system prompt ──────────┐
                                                  │                           │
                                                  └── identity token via ─────┤
                                                      environment variable    │
                                                                              ▼
                                                                            Agent
                                                                              │
                                                           reads API documentation when needed
                                                                              │
                                                           calls app-slack with agent identity token
```

This provides progressive disclosure as part of outbound connectivity: every
agent receives only a short description of the available capability, while
detailed API instructions enter the context only when the agent chooses to use
it. The identity token then lets the external service authenticate which agent
is making the request.

## Application boundary

System prompt registration is a generic Mobius capability. Mobius stores and
delivers registered prompt contributions without knowing that a service is
Slack, Discord, or any other application.

The dependency direction is from the application to Mobius:

- The application registers, updates, or removes its prompt contribution.
- The application hosts its own API and detailed API documentation.
- The application verifies the Mobius-issued agent identity token and performs
  its own business authorization.
- Mobius does not call the application, proxy its API, ship an application SDK,
  or depend on the application being present.

As a result, `app-slack` and other `app-*` services can be added or removed
without changing Mobius itself.

### Session-only agent execution

Mobius stores and runs work as project-scoped Sessions. A Session pins its
Runtime, local Agent, workspace, and per-Turn configuration snapshot before
dispatch. The paired daemon remains the authority for executable, directory,
and side-effect decisions.

Standalone and Platform expose separate hosting trust planes. Standalone keeps
accountless Project ownership; Platform adds OIDC developers, Tenant/App
provisioning, AppCredentials, and exact-Session browser credentials. Both
normalize authorized work into the shared Project and Session services while
Runtime authority remains independent.
See [Cloudflare Platform hosting](docs/platform-hosting.md) and [Project
authentication and credential operations](docs/project-authentication.md).

### Agent harness integrations

Implemented local integrations:

- Codex
- Claude Code
- GitHub Copilot CLI through `copilot --no-auto-update --acp --stdio`
- Pi coding agent through `pi-acp`
- DeepSeek Harness through `dsh --profile acp`
- Hermes Agent through `hermes acp`
- OpenCode through `opencode acp`
- Cursor CLI through `cursor-agent acp`
- Grok Build through `grok agent stdio`
- WorkBuddy through CodeBuddy Code's `codebuddy --acp`
- Gemini CLI through `gemini --acp`

Cloud-based integration targets:

- `claude-cowork`
- `chatgpt-work`
- `grokbot`

## Development

Repository development requires Node.js 24.20.0 and pnpm. The published CLI supports Node.js 22.13.0 or newer.
The CLI supports Linux on x64 and arm64, including glibc and musl distributions;
individual Agent executables must also support the selected distribution.
DeepSeek Harness `0.1.2-rc.1` ships glibc-linked `node-pty` Linux binaries, so
install `bash`, `ca-certificates`, and `gcompat` before using it on Alpine:

```bash
apk add --no-cache bash ca-certificates gcompat
```

```bash
pnpm install
pnpm lint
pnpm typecheck
```

Start the local Cloudflare Lite deployment profile and production Web build:

```bash
pnpm dev:relay
```

`pnpm dev:cloudflare` is the explicit profile command; `pnpm dev:relay` remains
its short alias. The command applies local D1 migrations before Wrangler starts.
Lite stores compressed session archive chunks in each Session Durable Object's
SQLite database and does not require an R2 binding.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The default page creates a
short-lived pairing code and displays a command like this:

```bash
npx --yes @moxt-ai/mobius pair --url http://127.0.0.1:8787 --pairing <runtime-pairing-id> --code XXXX-XXXX-XXXX-XXXX-XXXX
```

Run that command anywhere on the machine. The published
`@moxt-ai/mobius` package is the extensible Mobius CLI; pairing and the long-lived
daemon are capabilities within that package. The command prepares the default
`~/.mobius/workspace`, claims the one-time code, starts the daemon, and keeps the
terminal open. Pass `--workspace <directory>` to choose a different default.
When developing the CLI from this checkout, the equivalent command is
`pnpm mobius pair ...`.
The browser then moves to an independent `/channels/<channel-id>` route. Every new
conversation can select any locally verified built-in Agent integration; the
selection is locked after its first message so the ACP session remains coherent
across turns. Conversations run independently, so a user can switch chats, create
another chat, and start a second agent task while an earlier conversation is still
working.

The channel sidebar links directly to Agent settings and to
`/channels/<channel-id>/access`. Agent settings shows verified local Agents
separately from supported Agents that still need setup. A locally detected Agent
shows its reported version and executable path; an Agent that was not detected is
explicitly labeled `Not installed`. After the paired daemon connects, Mobius
automatically installs or repairs only the ACP integration for each locally
detected Agent. Setup cards stay out of the conversation sidebar. The single
`Check again` action re-runs local Agent detection and automatically installs the
integration for each Agent it finds; missing Agents have no integration action.
The public Runtime descriptor includes the reported path and version together
with capability booleans observed during each ready Agent's bounded ACP probe.
The page does not expose provider credentials or offer a remote Agent uninstall
action.

The pairing browser stores an owner host credential for the channel. The normal
URL contains only the channel address, so opening it in another browser without
a credential cannot submit work or read persisted history. On the Access from
other devices page, the owner can create an accountless access link that expires
after ten minutes and works once. Its secret stays in the URL fragment, is stored
only as a hash by the Relay, and is exchanged for a distinct linked-device
credential.
The owner can list and revoke linked devices without rotating its own credential;
revocation also closes an active linked-device WebSocket. These links are bearer
capabilities for trusted device transfer, not user or team identity.

An embedding application that holds the Project owner credential can add more
independent machines to the same Project through the Project-scoped Runtime
pairing API. Each new Runtime has a separate Channel, daemon credential, online
state, and Agent catalog. Sessions select one authorized Runtime; an owner can
revoke one without disconnecting the others, and pinned work never
silently fails over. See [Project Runtime pairing](docs/runtime-pairing.md) for
the HTTP contract, SDK workflow, quota, audit, and revocation semantics.

Pairing writes mode-`0600` connection data below
`~/.mobius/installations/dev.mobius.cli/<installation-id>/connections` for the
standalone CLI. To restart a previously paired daemon, use the opaque Connection
ID printed by `mobius pair`:

```bash
npx --yes @moxt-ai/mobius start --connection <connection-id>
```

`mobius start --channel <channel-id>` remains a compatibility path: it first
looks up the standalone CLI's own index, then imports only that exact legacy
flat-file record if necessary.

Every daemon WebSocket attempt has a process-local, monotonically increasing
connection epoch. The CLI prints structured `Mobius relay diagnostic` records
for open, close, heartbeat-timeout, socket/proxy failure, and catalog-publication
failure outcomes. The same records are stored in the local daemon SQLite
`audit_events` table as `relay_connection_opened`, `relay_connection_closed`,
`relay_heartbeat_timed_out`, `relay_connection_failed`, and
`agent_catalog_publish_failed`. Close records include the code, reason, and
source; failure records include sanitized error chains and whether the Relay was
reached directly or through the configured environment proxy. Diagnostics retain
origins only and never record Relay query credentials or proxy credentials.
Healthy sockets are not rotated on a fixed timer; negotiated heartbeat deadlines
recover connections that actually become unresponsive.

Mobius does not bundle the supported Agent CLIs or their platform binaries.
Pairing and every saved-channel start discover each Agent's direct ACP command or
CLI-plus-adapter pair, run bounded version probes, and complete an ACP initialize
handshake. Pi also has to create a session and finish a bounded `/session`
conformance prompt through `pi-acp -> pi --mode rpc`.
DeepSeek Harness runs directly as `dsh --profile acp`; Mobius uses the `dsh` CLI
version because the current ACP profile reports its internal bridge version.
GitHub Copilot CLI runs directly as `copilot --no-auto-update --acp --stdio`;
Mobius also sets `COPILOT_AUTO_UPDATE=false` while it owns the process. Hermes
Agent runs directly as `hermes acp`, with discovery also checking the official
per-user `~/.local/bin/hermes` installation location.
OpenCode runs directly as `opencode acp` with its own auto-update disabled while
Mobius owns the process. Cursor CLI, Grok Build, WorkBuddy, and Gemini CLI run
through their native ACP entrypoints; readiness also requires successful session
creation. Gemini CLI uses its stable `gemini --acp` entrypoint. On macOS,
WorkBuddy discovery checks the embedded
`codebuddy` executable in both the system and current user's standard
`WorkBuddy.app` locations, so the desktop application does not need to add its
private CLI to `PATH`. Cursor's optional question and plan extensions are
safely declined during discovery and normal turns. Only complete integrations are
advertised. Inspect the local result without pairing:

```bash
npx --yes @moxt-ai/mobius agents
npx --yes @moxt-ai/mobius agents --json
```

Discovery checks these explicit local overrides before direct `PATH` lookup:

- `MOBIUS_CODEX_PATH` and `MOBIUS_CODEX_ACP_PATH`
- `MOBIUS_CLAUDE_PATH` and `MOBIUS_CLAUDE_ACP_PATH`
- `MOBIUS_COPILOT_PATH`
- `MOBIUS_PI_PATH` and `MOBIUS_PI_ACP_PATH`
- `MOBIUS_DEEPSEEK_HARNESS_PATH`
- `MOBIUS_HERMES_PATH`
- `MOBIUS_OPENCODE_PATH`
- `MOBIUS_CURSOR_PATH`
- `MOBIUS_GROK_BUILD_PATH`
- `MOBIUS_WORKBUDDY_PATH`
- `MOBIUS_GEMINI_PATH`

Automatic lookup uses the `PATH` inherited by the Mobius process, plus documented
Agent-specific installation locations such as the macOS WorkBuddy application
bundle. An explicit override is authoritative and fails closed; an automatically
found executable must pass the full probe before Mobius may fall back to a
previously verified private cache entry. The default working directory does not
affect discovery.
The daemon publishes each detected Agent's discovered executable path and reported
version as authenticated channel catalog metadata so Agent settings can display
them. This means the channel owner and linked devices can read those two local
details through the Relay. File identities, adapter paths, probe output, launch
environment, and provider credentials stay on the local machine.

The pairing claim and saved-channel startup discovery are read-only. A detected
Agent whose ACP adapter is missing, broken, or incompatible is first published
with `integration_not_installed`; an absent or unverified Agent is published
with `agent_not_installed`. After the daemon has authenticated its first Relay
connection, it automatically installs and verifies the pinned private ACP
adapter for every locally detected `integration_not_installed` Agent. It never
downloads, installs, upgrades, removes, or signs in to an Agent CLI.

`mobius agents` prints the exact lightweight adapter recovery command when
applicable. The one-time pairing claim remains read-only.

When no verified integration is ready, the paired daemon keeps the channel
online and Web still lists every supported Agent. The user installs the Agent CLI
themselves; detected Agents are set up automatically. Selecting `Check again`
makes the local daemon rediscover all setup Agents at that moment and
automatically provisions integrations for those it finds, so a CLI installed
after daemon startup is recognized without pairing again. If an Agent is still
absent, its request fails with
`agent_not_installed` and asks the user to install it locally. Mobius never
downloads, installs, upgrades, removes, or signs in to an Agent CLI through this
action or the automatic setup path.

For a detected bridged Agent, automatic setup or an explicit recheck may install
the exact pinned ACP adapter into Mobius's private cache, then repeats normal
discovery and the ACP initialize handshake before advertising the integration as
ready. Direct ACP Agents only repeat verification because they need no separate
adapter. An explicit adapter override remains authoritative and is never
replaced. Failure does not take the channel offline; the Agent remains in the
setup catalog with a sanitized diagnostic and can be included in the next
recheck. Progress events
contain stable integration stages and errors, never commands, URLs, adapter
paths, raw output, environment values, or credentials.

The Web request cannot change a release channel, command, URL, arguments, or
installation target. Local provider credentials remain with the Agent process
and never cross the Relay. Pi
authentication is a local terminal action through `pi-acp --terminal-login`;
GitHub Copilot CLI uses `copilot login`, Hermes Agent uses `hermes acp --setup`,
and Gemini CLI uses its locally configured OAuth, API-key, Vertex AI, or gateway
authentication. OpenCode uses `opencode auth login`, Cursor uses `cursor-agent login`,
Grok Build uses `grok login`, and WorkBuddy opens its local sign-in through `codebuddy`.
DeepSeek Harness reads credentials from its validated local home or launch
environment; use the local `dsh web` Models page or `DEEPSEEK_API_KEY` to
configure the default route. `mobius agents` reports ACP
authentication failures as `authentication_required` without exposing a
credential.

Every ready Agent exposes three required run settings: **Permissions**,
**Model**, and **Reasoning effort**. Model and reasoning choices come from the
Agent when its ACP integration supports them; otherwise Mobius keeps a visible,
single-choice `Agent default` value instead of dropping the field. Permissions
are owned by the local execution boundary. DeepSeek Harness maps the selected
mode to `DSH_PERMISSION_MODE`, and OpenCode receives an equivalent native
`permission` policy through its highest-precedence inline configuration. An
Agent without a verified native mapping exposes a disabled `Agent default`
choice rather than pretending to enforce a sandbox it does not support. Pi is
explicitly reported as disabled `Full access (Pi default)` because it runs with
the local Runtime user's authority and has no built-in sandbox. A selected
adjustable mode is applied before the Agent process starts.

Each conversation negotiates its available ACP capabilities with the selected
agent. The Web chat always exposes the three required run settings and, when
provided by that agent, also exposes session mode, boolean options such as fast mode, context-window usage and
cost, slash commands, permission requests, form or URL elicitation, image and
embedded-resource prompts, rich agent content, and structured tool details.
Rapid snapshots for one activity are coalesced before they enter the durable
Relay outbox: the first snapshot and terminal state are immediate, while only the
latest intermediate snapshot is emitted in each 100-millisecond window. Final
activity content is preserved.
Unsupported optional controls are omitted instead of being simulated by Mobius.
In particular, Pi does not advertise ACP filesystem delegation, terminal
delegation, or MCP passthrough while `pi-acp@0.0.33` does not implement them.
Pi prompts have a five-minute outer Mobius deadline. A timeout closes the ACP
connection and terminates the detached adapter process group, including its Pi
RPC child. DeepSeek Harness advertises its current list, resume, close, and HTTP
MCP capabilities; unsupported load, additional-directory, delete, fork, image,
audio, embedded-resource, and elicitation features remain absent. OpenCode's ACP
session lifecycle, including persisted load/resume behavior, is negotiated from
the running binary. GitHub Copilot CLI must provide load and list support,
Hermes Agent must provide load, list, resume, and fork support, and Gemini CLI
must provide load support before Mobius advertises them. Hermes native session
management remains scoped to the running ACP process;
Mobius does not present it as cross-process persistence.

Open **Local sessions** in the sidebar, then choose an installed Agent to see
its saved conversations across projects on the paired machine. This works before starting a chat
and does not change the current conversation's Agent. Switching Agents cancels the
previous load and only shows sessions from the selected Agent. The list supports
filtering loaded titles and pagination; each row opens a session, with fork and
delete available from its actions menu when supported.
**Open** imports a conversation and continues its saved Agent context; opening
the same native session again refreshes history in its existing Mobius conversation.
**Fork** creates an independent continuation when the Agent advertises the
experimental fork capability. An imported or forked conversation keeps its Agent
and workspace fixed. Agents that support ACP `session/load` replay their previous
user and assistant messages into Mobius. The transcript is retained across page
reloads, and reopening does not duplicate turns already recorded in Mobius. The
most recent 10 messages are displayed when history exceeds the preview limits.
Attachment placeholders are shown; historical tool execution and
reasoning are not replayed as live activity. Agents that only support resuming
context show a notice that message history is unavailable.

Loading restores saved context and history; it does not attach to an Agent process
running in another app or stream that process's future output. When Codex cannot
resume a session, Mobius tries its read-only history API and shows a saved-history
preview. The preview creates no executable conversation and leaves the original
writer alone. **Continue original** retries restoration, and **Fork session**
creates an independent continuation when supported. If another app owns the
session, release it there before continuing the original. Failures appear beside
the selected session with an operation-specific retry or a list refresh.
Mobius rejects management actions while its own daemon is running a turn for that
session. ACP does not standardize cross-process ownership or live takeover; see
[the protocol findings and proposed concurrency behavior](docs/native-session-concurrency.md).

Native session deletion requires Agent support and one confirmation in the web
interface. No second terminal confirmation is needed. The local daemon re-resolves
the selected session and its working directories with the paired machine identity
immediately before deletion. Cancel or close the browser
dialog to cancel the request; operations time out after 90 seconds. Sessions running
in this Mobius daemon cannot be deleted. Messages recorded in Mobius are retained, while the deleted
native session cannot be resumed through its old Mobius conversation, even after
a daemon restart. Native IDs and Agent pagination cursors stay on the paired
machine; the browser receives the directory labels needed for project selection.

After a prompt completes, users can open the Agent usage indicator to see the
latest reported token breakdown and supported Agent quota metadata, including
per-model totals from Codex ACP 1.8.0 and Claude ACP 0.73.0. These snapshots
survive a browser reload. Context occupancy and cumulative cost come only from
`usage_update`; final prompt counters are preserved separately and never added
to context usage, quota totals, or earlier reports. Cache and reasoning counters
can overlap other counters, and Claude's model totals can include subagent work.
Missing measurements stay unavailable. Unknown metadata is discarded, while
malformed supported fields fail with a sanitized `acp_invalid_prompt_response`
error at the local ACP boundary.

New conversations use `~/.mobius/workspace` by default. The workspace picker
starts at the user's Home directory and can navigate to any directory available
to that local user. The daemon validates and resolves every selected primary or
additional directory immediately before starting or configuring an ACP session.

For Web hot reload, run the relay and Vite together, then open
[http://127.0.0.1:5190](http://127.0.0.1:5190):

```bash
pnpm dev:stack
```

### Worktree development

Create an isolated development checkout from the latest `origin/main` without
installing or invoking Quack:

```bash
pnpm run worktree:new -- pairing-history
```

The command creates `.worktrees/pairing-history` on branch
`worktree/pairing-history`, allocates a stable relay/Web port pair that does not
conflict with registered Mobius worktrees, keeps the main checkout's default
ports available, and installs the locked workspace dependencies. It prints the
checkout path and assigned ports when it finishes. If the retained local branch
already exists, the command reopens it instead of replacing its history.

Inside that checkout, Vite and the local Wrangler command automatically read
the generated mode-`0600` `.env.worktree` file. Start both hot-reload servers
with:

```bash
pnpm dev:stack
```

Inspect or repair the checkout's port claim with `pnpm worktree:ports` and
`pnpm worktree:repair-ports`. Stop its development servers before repairing the
ports. `pnpm worktree:reset` keeps source changes, allocates an available port
pair, and restores locked dependencies.

To remove a clean, stopped worktree while retaining its local branch, run
`pnpm run worktree:delete` inside it. From the main checkout, pass the managed
directory name instead:

```bash
pnpm run worktree:delete -- pairing-history
```

### Cloudflare deployment profiles

The default profile is Cloudflare Lite. It uses Worker Static Assets, D1, and
SQLite-backed Durable Objects, so a new deployment does not need R2 activation
or a billing card:

```bash
pnpm wrangler deploy
```

Lite limits immutable archive chunks to 256 MiB per session by default. Change
`SESSION_ARCHIVE_BYTES_PER_SESSION` in `packages/relay-cloudflare-standalone/wrangler.jsonc`
to choose a different positive byte limit. The limit is enforced atomically by
the Session Durable Object; exceeding it returns the stable
`session_quota_exceeded` error and preserves the hot copy for recovery.

For deployments that need R2-backed archive capacity, use the separate profile:

```bash
pnpm deploy:cloudflare:r2
```

The Lite and R2 profiles use distinct Session Durable Object classes. Select a
profile before the first deployment and continue using it for that Worker;
switching profiles does not migrate existing session history. In particular, an
existing R2 deployment must keep using `pnpm deploy:cloudflare:r2`.

For multi-tenant application hosting, deploy the independent Platform Worker:

```bash
pnpm deploy:cloudflare:platform
```

Platform requires deployment-owned OIDC, browser-origin, and two-D1 binding
configuration and never enables accountless public bootstrap. It does not alter
the Standalone Worker or its data. See [Cloudflare Platform
hosting](docs/platform-hosting.md) for initial provisioning and credential
boundaries.

### One-command Cloudflare preview

Run the temporary deployment from the repository root:

```bash
pnpm wrangler deploy --temporary
```

This command builds the React application and deploys it as Worker Static Assets
together with the Relay Worker, SQLite-backed Durable Objects, and an
automatically provisioned D1 binding. It uses the default Lite profile and does
not provision R2. Wrangler prints the temporary account's claim URL, and Mobius
prints the Web URL. Open that URL and use the one-time command shown by the
pairing page. The wrapper uses a dedicated temporary profile automatically, so
an unrelated Wrangler login does not need to be removed or overwritten.

The daemon and browser receive separate high-entropy credentials whose hashes and
channel metadata are stored in D1. The pairing code expires after ten minutes and
can be claimed only once. A channel ID addresses a runtime but is not an access
credential; each authorized browser retains its own host credential locally.
Mobius itself has no account system. A future identity service can own user and
team policy while issuing or revoking the same scoped capabilities.

Forward D1 migrations preserve existing pairings while separating explicit
Project-owner credentials from Runtime Channels and adding Project-scoped
Runtime pairing, lifecycle, quota, and audit records.

Cloudflare may apply an abuse-prevention challenge to an unclaimed temporary
preview. If that blocks the non-browser daemon, claim the deployment using the
private URL printed by Wrangler, or deploy from an authenticated account without
`--temporary`, then run the newly generated pairing command. The cloud deployment
does not run the local daemon or ACP agent; the pairing command starts it locally.

The Web package uses Vite, TypeScript, React, Zustand, Tailwind CSS, and local
shadcn/ui components. Zustand owns live page state, while independent Session
Durable Objects record accepted commands, concrete attempts, ordered events, and
archive references. Raw event payloads stay in the Durable Object only while a
Turn is active: text deltas are packed into bounded stream blocks, while the
event table keeps ordering and idempotency metadata. Its terminal transaction
first materializes the canonical message read model, then removes that Turn's raw
events and stream blocks and advances the event cursor floor; compact payload-free
receipts keep a lost terminal acknowledgement idempotent. Historical chat is
restored from the paginated message read model, not by replaying deltas.
In the default Lite profile, full tool details are stored in the same Session
Durable Object's SQLite database; the R2 profile stores those detail chunks in
R2. The Web opens one paginated message page and loads full tool details only when
expanded. Prompts and agent responses are therefore persisted in Cloudflare; local
agent credentials remain only on the paired machine. Each conversation keeps one
Mobius session across turns. The daemon stores the corresponding native ACP
session identifier in its local SQLite database and uses ACP resume or load after
a daemon restart when the selected agent advertises that capability.

## Workspace layout

```text
packages/
  relay-core/        Relay API, services, Cloudflare Durable Objects, D1, R2, and migrations
  relay-cloudflare-platform/  Multi-tenant Platform Worker and control plane
  relay-cloudflare-standalone/  Standalone Worker entry point and deployment composition
  cli/               Publishable @moxt-ai/mobius CLI and reusable /runtime engine
  protocol/          Shared Mobius commands, events, capabilities, and codecs
  web/               React agent chat application and shadcn/ui components
  mobius-sdk/        Browser-and-Node TypeScript SDK
deploy/
  docker/            Reserved for a future Docker deployment profile
e2e/
  fixtures/
    fake-acp-agent/
docs/
scripts/
```

All runnable and importable product workspaces live under `packages/`.
External boundary fixtures remain under `e2e/fixtures` because they are
deterministic test dependencies rather than shipped product units.

## D1 migrations

See [shared D1 shard migrations](docs/d1-migrations.md) to initialize Cloud-owned
shards with this business's SQL files and independent migration history.
