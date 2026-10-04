# Testing

## Commands

| Command | Scope |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Static validation, including real Agent scenarios |
| `pnpm test` | Controlled CLI, Protocol, SDK and hosting suites |
| `pnpm test:agent-daemon:controlled` | CLI session and runtime boundaries |
| `pnpm test:agent-daemon:real` | Real daemon, Agent executables and production adapters |
| `pnpm build` | Bundles without deployment |

## Ownership

- [CLI tests](packages/cli/tests/): `agents/` proves real executable compatibility;
  `sessions/` covers session behavior and protocol faults; `runtime/` covers
  process, discovery, installation, connection and local security boundaries.
  Controlled ACP scenarios live beside their owners in `sessions/fixtures/` and
  `runtime/fixtures/`; they run directly as CLI test subprocesses without a separate
  package or build. `support/` contains launchers, controlled LLM providers and
  shared process I/O helpers.
  [Prerequisites](packages/cli/tests/README.md) describe executable setup.
- [Shared test support](packages/test-support/src/): real local Platform/Cloudflare
  infrastructure and the stateful fake daemon exposed through package exports.
  It does not start the production CLI or import controlled ACP peers.
- Web / Chat consumer suites use the shared fake daemon over real transports and
  real product services. Consumers inject their own reply scenarios.
- [Protocol](packages/protocol/tests/) and [SDK](packages/mobius-sdk/tests/) own
  their wire contracts. Hosting and Web packages own their integration scenarios.

Controlled ACP peers test explicit protocol faults; they do not establish Agent
compatibility. Real Agent tests use controlled LLM providers without production
accounts. Missing required executables fail instead of falling back to fake Agents.

[Package scripts](package.json) and [CI](.github/workflows/ci.yml) define execution.
Follow [AGENTS.md](AGENTS.md) for acceptance boundaries and resource cleanup.

## Proving the product contract

Use the [product requirements](README.md#functional-value) to select
observable scenarios. For current-turn changes, relevant cases include a second
subscriber joining mid-turn, another client's accepted prompt, reconnect across
completion, delayed history handoff, session switching and cancellation races.
Assert recovered content and outcomes rather than internal batching or callback counts.

Controlled peers make ordering and faults reproducible; real-Agent scenarios prove
adapter behavior. Neither alone establishes the entire remote user journey. A passing
happy path does not establish restart recovery or history completeness. Report the
boundary, Agent and failure conditions actually exercised, and track unmet requirements
as gaps rather than documenting them as implemented guarantees.
