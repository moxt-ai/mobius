# Mobius

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

### Planned agent harness integrations

Initial integration targets include:

- DeepSeek harness
- Pi coding agent
- Codex
- Claude Code
- `opencode`
- `cursor-cli`
- `grok-build`

Cloud-based integration targets:

- `claude-cowork`
- `chatgpt-work`
- `grokbot`

## Development

Repository development requires Node.js 24.20.0 and pnpm. The published CLI supports Node.js 22.13.0 or newer.

```bash
pnpm install
pnpm check
```

Start the local Cloudflare deployment profile and production Web build:

```bash
pnpm dev:relay
```

`pnpm dev:cloudflare` is the explicit profile command; `pnpm dev:relay` remains
its short alias. The command applies local D1 migrations before Wrangler starts.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The default page creates a
short-lived pairing code and displays a command like this:

```bash
npx --yes @moxt-ai/mobius pair --url http://127.0.0.1:8787 --code XXXX-XXXX-XXXX-XXXX-XXXX --root "$PWD"
```

Run that command from the workspace that Mobius may access. The published
`@moxt-ai/mobius` package is the extensible Mobius CLI; pairing and the long-lived
daemon are capabilities within that package. The command resolves and approves
the supplied root, claims the one-time code, starts the daemon, and keeps the
terminal open. When developing the CLI from this checkout, the equivalent
workspace command is `pnpm mobius pair ...`.
The browser then moves to an independent `/channels/<channel-id>` route. Every new
conversation can select a locally verified Codex or Claude Code integration; the
selection is locked after its first message so the ACP session remains coherent
across turns. Conversations run independently, so a user can switch chats,
create another chat, and start a second agent task while an earlier conversation
is still working.

The channel sidebar links to `/channels/<channel-id>/settings`, where the user can
see verified local Agents separately from supported integrations that still need
installation or recovery. Missing integrations use the same locally authorized
install, retry, progress, and cancellation flow. The page intentionally does not
expose local paths, versions, credentials, or a remote uninstall action.

The channel URL can be opened directly in any browser while its local daemon is
running. During this early phase, the high-entropy channel identifier is the only
browser-side access boundary: anyone who receives the URL can submit agent work
to the paired workspace and read its persisted history. Add user or team
authentication before exposing a channel beyond trusted collaborators.

Pairing writes a mode-`0600` connection file under `~/.mobius/connections`. To
restart a previously paired daemon, use the channel identifier shown in its URL:

```bash
npx --yes @moxt-ai/mobius start --channel <channel-id>
```

Mobius does not bundle Codex, Claude Code, or their platform binaries. Pairing
and every saved-channel start discover the Agent CLI and its ACP adapter, run
bounded version probes, and complete an ACP initialize handshake. Only complete
integrations are advertised. Inspect the local result without pairing:

```bash
npx --yes @moxt-ai/mobius agents
npx --yes @moxt-ai/mobius agents --json
```

Discovery checks these explicit local overrides before direct `PATH` lookup:

- `MOBIUS_CODEX_PATH` and `MOBIUS_CODEX_ACP_PATH`
- `MOBIUS_CLAUDE_PATH` and `MOBIUS_CLAUDE_ACP_PATH`

Automatic lookup will not select an executable inside the approved workspace.
An explicit override is authoritative and fails closed; an automatically found
external executable must pass the full probe before Mobius may fall back to a
previously verified private cache entry.
Executable paths, versions, identities, probe output, and adapter environment
stay on the local machine. The Relay receives only stable Agent identifiers,
labels, and sanitized ready/installable metadata.

If an Agent CLI passes local executable and version checks but its adapter is
missing, broken, or ACP-incompatible, the paired daemon automatically installs
the exact pinned adapter into Mobius's private cache with optional platform Agent
dependencies omitted. It then repeats the complete discovery and ACP initialize
handshake before advertising the Agent. Mobius never installs or replaces the
Agent CLI through this automatic path. An explicit adapter override remains
authoritative and is never replaced automatically. Adapter installation failure
does not take the channel offline; the Agent remains in the installable catalog
with a sanitized diagnostic.

`mobius agents` and the one-time pairing claim remain read-only. The command
prints the exact lightweight adapter recovery command when applicable, while
automatic adapter provisioning begins only as the authenticated local daemon
starts.

When no verified Agent is ready, the channel remains online and Web offers the
supported fixed user-level Agent installation and recovery recipes. A Web click
is only a request:
by default, the terminal running Mobius must approve that individual request
before an installer starts. The initial recipes use the documented
[Codex standalone installer](https://learn.chatgpt.com/docs/codex/cli) and
[Claude Code native stable channel](https://code.claude.com/docs/en/installation).
Mobius downloads the official installer into a private temporary directory,
applies bounded verification and execution,
installs a pinned ACP adapter into `~/.mobius/adapters`, repeats normal ACP
discovery, and publishes the Agent only after the full path succeeds. Progress
sent to Web contains stages and stable errors, never commands, URLs, paths, raw
output, environment values, or credentials. Installing an Agent does not sign
the user into its provider.

A local user may explicitly grant one fixed recipe by creating a private
mode-`0600` `~/.mobius/installation-grants.json` file:

```json
{
  "version": 1,
  "agents": ["codex"]
}
```

The grant is disabled by default, is scoped to the listed built-in Agent IDs,
and is revoked by removing an ID or the file. It cannot change a release
channel, command, URL, arguments, or installation target. Local provider
credentials remain with Codex or Claude Code. Only the resolved root approved
by the pairing command can be used as the `workspace` binding.

Each conversation negotiates its available ACP capabilities with the selected
agent. When provided by that agent, the Web chat exposes session mode, model,
reasoning effort, boolean options such as fast mode, context-window usage and
cost, slash commands, permission requests, form or URL elicitation, image and
embedded-resource prompts, rich agent content, and structured tool details.
Unsupported controls are omitted instead of being simulated by Mobius.

The workspace picker never sends local paths to the browser. It uses opaque
directory identifiers, and the daemon resolves and authorizes every primary or
additional directory against the root approved during pairing immediately
before starting or configuring an ACP session.

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

### One-command Cloudflare preview

Run the temporary deployment from the repository root:

```bash
pnpm wrangler deploy --temporary
```

This command builds the React application and deploys it as Worker Static Assets
together with the Relay Worker, Durable Object, and an automatically provisioned
D1 binding. Wrangler prints the temporary account's claim URL, and Mobius prints
the Web URL. Open that URL and use the one-time command shown by the pairing page.
The wrapper uses a dedicated temporary profile automatically, so an unrelated
Wrangler login does not need to be removed or overwritten.

The daemon receives a high-entropy channel token whose hash and channel metadata
are stored in D1. The pairing code expires after ten minutes and can be claimed
only once. Browser channel access is intentionally URL-based for now so a paired
channel opens in any browser; application authentication is a separate follow-up.

Cloudflare may apply an abuse-prevention challenge to an unclaimed temporary
preview. If that blocks the non-browser daemon, claim the deployment using the
private URL printed by Wrangler, or deploy from an authenticated account without
`--temporary`, then run the newly generated pairing command. The cloud deployment
does not run the local daemon or ACP agent; the pairing command starts it locally.

The Web package uses Vite, TypeScript, React, Zustand, Tailwind CSS, and local
shadcn/ui components. Zustand owns live page state, while each channel's Durable
Object records pending, running, completed, and failed turns and restores them
whenever the channel opens in another browser. Prompts and agent responses are
therefore persisted in Cloudflare; local agent credentials remain only on the
paired machine. Each conversation keeps one Mobius session across turns. The
daemon stores the corresponding native ACP session identifier in its local
SQLite database and uses ACP resume or load after a daemon restart when the
selected agent advertises that capability.

## Workspace layout

```text
packages/
  relay-core/        Portable Relay API, channel actor, state contracts, and ports
  relay-cloudflare/  Worker, Durable Objects, D1, and Worker Assets composition
  relay-node/        Reserved for the future single-instance Node profile
  cli/               Publishable @moxt-ai/mobius CLI, including the local daemon
  protocol/          Shared Mobius commands, events, capabilities, and codecs
  web/               React agent chat application and shadcn/ui components
  web-sdk/           Browser-facing SDK
deploy/
  docker/            Reserved for the future relay-node image
e2e/
  fixtures/
    fake-acp-agent/
docs/
scripts/
```

All runnable and importable product workspaces live under `packages/`. The empty
`relay-node` and `deploy/docker` placeholders make the intended deployment
boundary explicit without claiming Node or Docker support before those profiles
exist. External boundary fixtures remain under `e2e/fixtures` because they are
deterministic test dependencies rather than shipped product units.
