---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Testing

## Commands

| Command | Scope |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Static validation, including real Agent scenarios |
| `pnpm test` | Controlled CLI, Protocol, SDK and hosting suites |
| `pnpm test:agent-daemon:controlled` | CLI session and runtime boundaries |
| `pnpm test:agent-daemon:real` | Real daemon, Agent executables and production adapters |
| `pnpm build` | Bundles without deployment |

## Test boundaries

- Real Agent compatibility scenarios use the production daemon, adapter, and Agent
  executable. Use the prerequisites below to prepare a local run.
- Controlled daemon scenarios exercise protocol faults, lifecycle races, and local
  security boundaries through the production daemon. Keep each controlled peer
  beside the scenario that needs it.
- Morty and other Web consumer suites use a stateful fake daemon over real
  transports and product services. They must not depend on controlled ACP peers
  or start the production daemon.
- Protocol and SDK scenarios exercise public wire and API contracts. Hosting
  integration scenarios enter through production service boundaries.

Controlled ACP peers test explicit protocol faults; they do not establish Agent
compatibility. Real Agent tests use controlled LLM providers without production
accounts. Missing required executables fail instead of falling back to fake Agents.

## Real Agent prerequisites

Install the repository with its pinned Node and pnpm versions. Make the real Agent
executables and their production adapters available on `PATH`, or supply these
local executable overrides:

- Codex: `MOBIUS_TEST_CODEX_PATH`.
- Claude Code: `MOBIUS_TEST_CLAUDE_PATH` and `MOBIUS_TEST_CLAUDE_ACP_PATH`.
- OpenCode: `MOBIUS_TEST_OPENCODE_PATH`.
- Pi: `MOBIUS_TEST_PI_PATH` and `MOBIUS_TEST_PI_ACP_PATH`.

Use versions supported by the production Agent specifications; CI pins its own
executable versions. Compatibility scenarios use isolated Agent homes and workspaces
with local controlled model providers, without production accounts or existing user
sessions. Missing required executables must fail clearly, never fall back to a fake
Agent or silently skip a required case.

A compatibility claim must identify the executed scenario, Agent and platform.
Successful live output alone does not establish history, file recovery, permission
rejection or reconnect behavior. Track missing coverage in issues rather than keeping
a second coverage inventory in Markdown.

Follow [AGENTS.md](../AGENTS.md) for acceptance boundaries and resource cleanup.

Record manual verification results in the relevant pull request and attach
screenshots there. Do not commit one-off reports or screenshots to the repository.
Keep durable behavioral guarantees in executable tests.
