# Mobius

## Host & connect with your agents

Mobius provides a network layer for hosting, reaching, and operating agents across
your local and cloud machines.

- **Host and connect** — Proxy network traffic to agents distributed across
  multiple local or cloud machines, manage their lifecycle, and expose them as
  network services that can be reached and invoked remotely.
- **Agent identity for outbound requests** — When an agent initiates a request
  to an external service, Mobius can issue a signed identity token for the
  agent to use for authentication. In the human world, Google provides Gmail
  accounts as an identity service; Mobius provides the equivalent identity
  layer for agents. Third-party services must explicitly support and accept
  this new token type.
- **Centralized LLM provider management (optional)** — Manage the LLM
  providers used by your agents from one place, making it easy to switch a
  coding-plan subscription or change the API server with a single action.

### Supported agent harnesses

Mobius supports the following agent harness types:

- DeepSeek harness
- Pi coding agent
- Codex
- Claude Code
- `cursor-cli`
- `grok-build`

Cloud-based agent harnesses:

- `claude-cowork`
- `chatgpt-work`
- `grokbot`

## Development

Requires Node.js 24.20.0 and pnpm.

```bash
pnpm install
pnpm check
pnpm test:coverage
```
