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
  executable. See [prerequisites](packages/cli/tests/README.md) for executable setup.
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

Follow [AGENTS.md](AGENTS.md) for acceptance boundaries and resource cleanup.
