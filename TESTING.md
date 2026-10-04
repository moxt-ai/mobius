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
  `support/` contains executable launchers, controlled LLM providers and ACP peers.
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
