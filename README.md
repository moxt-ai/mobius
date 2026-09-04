# Mobius

## Project direction

Mobius is being built as a network layer for hosting, reaching, and operating
agents across your local and cloud machines. The planned product scope includes:

- **Host and connect** — Proxy network traffic to agents distributed across
  multiple local or cloud machines, manage their lifecycle, and expose them as
  network services that can be reached and invoked remotely.
- **Agent identity for outbound requests** — When an agent initiates a request
  to an external service, Mobius can issue a signed identity token for the
  agent to use for authentication. In the human world, Google provides Gmail
  accounts as an identity service; Mobius provides the equivalent identity
  layer for agents. Third-party services must explicitly support and accept
  this new token type.
- **System prompt delivery** — External applications can register small system
  prompt contributions with Mobius. Mobius includes the registered content in
  the system prompt delivered to an agent, allowing the application to disclose
  its service URL, API discovery location, and authentication method.
- **Minimal and composable** — Mobius is intentionally small: it can be
  deployed on a free Cloudflare Workers plan with minimal dependencies and
  provides only a simple web interface. Dedicated services and apps provide
  integrations for Slack, Discord, other IM platforms, and mobile devices.
  Keeping Mobius's scope as small as possible makes it easy to compose with
  these services into a complete team solution.
- **Centralized LLM provider management (optional)** — Manage the LLM
  providers used by your agents from one place, making it easy to switch a
  coding-plan subscription or change the API server with a single action.

## Progressive capability disclosure

Mobius does not need to install a local tool or place a complete API schema in
an agent's context for every available application. Instead, an application
registers a concise system prompt contribution with Mobius for the relevant
tenant or agent.

For example, `app-slack` can register content that tells an agent:

- A Slack web service is available.
- Where that service and its detailed API documentation can be found.
- That requests must use an agent identity token issued by Mobius.

Mobius injects this contribution when it builds the agent's system prompt. The
agent then decides whether the capability is relevant. Only when needed does the
agent read the application's detailed API documentation, obtain its identity
token from Mobius, and call the web service using an available HTTP client such
as `curl`.

```text
app-slack ── registers prompt contribution ──> Mobius
                                                  │
                                                  └── injects system prompt
                                                          │
                                                          ▼
                                                        Agent
                                                          │
                                       reads API documentation when needed
                                                          │
                                       calls app-slack with agent identity token
```

This provides progressive disclosure: every agent receives only a short
description of the available capability, while detailed API instructions enter
the context only when the agent chooses to use it.

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

Requires Node.js 24.20.0 and pnpm.

```bash
pnpm install
pnpm check
```
