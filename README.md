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

Requires Node.js 24.20.0 and pnpm.

```bash
pnpm install
pnpm check
```
