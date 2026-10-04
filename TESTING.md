# Testing

## Commands

| Command | Scope |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | Static validation |
| `pnpm test` | Controlled daemon, Protocol, SDK and hosting suites |
| `pnpm test:agent-daemon:controlled` | Deterministic protocol and daemon scenarios |
| `pnpm test:agent-daemon:real` | Real Agent executables and production adapters |
| `pnpm build` | Bundles without deployment |

Run affected suites during development. [package.json](package.json) and
[CI](.github/workflows/ci.yml) own the actual command composition.

## Executable boundaries

- [Real daemon assembly](tests/agent-daemon/infra/real-daemon.ts) composes production
  discovery and daemon execution. [Agent fixtures](tests/agent-daemon/infra/) select
  real executables; [providers](tests/agent-daemon/providers/) control model output.
- [Real scenarios](tests/agent-daemon/real/) establish per-Agent compatibility.
  [Prerequisites](tests/agent-daemon/README.md) describe local executable setup.
- [Controlled scenarios](tests/agent-daemon/controlled-agent/) exercise specific
  protocol shapes and faults. Passing them does not establish real Agent compatibility.
- [Consumer harness](tests/infra/platform-agent-harness.ts) and
  [daemon launcher](tests/infra/run-agent-harness-daemon.ts) define the current shared
  test composition. Consumers own their Web-level scenarios and replacement policy.
- [Protocol](packages/protocol/tests/) and [SDK](packages/mobius-sdk/tests/) own
  their observable wire boundaries. Hosting packages own local Cloudflare tests.

Follow [AGENTS.md](AGENTS.md) for acceptance scenarios, resource cleanup and time
control. Controlled model providers allow real Agent execution without production
accounts. Missing required executables fail rather than falling back to fake Agents.
Do not replace a real compatibility scenario with the same peer under another name.

Dated `artifacts/` reports document individual manual runs; they are not contracts.
