# Agent-daemon integration tests

## Ownership

These tests cover the real local daemon together with each real Agent and its
production adapter. Web / Chat tests independently use a stateful fake daemon
with real product services; they do not test Agent adapter compatibility. See
[the testing guide](../../TESTING.md) for the shared boundary contract.

Use separate Agent scenarios because native APIs, adapters, history, cancellation,
interactions, and session identity may differ. Share only common fixture plumbing.
The real Agent must execute tools and own its native session history. A controlled
model provider can make its output deterministic without replacing the Agent.

## Current coverage and gaps

| Agent | Real daemon acceptance coverage | Existing fixture |
| --- | --- | --- |
| Codex | `real/codex-live-turn.integration.test.ts`: real Codex app-server, streaming/tools, queue cancellation, execution snapshots, history and files | `infra/codex.ts` |
| Claude Code | Not yet implemented; must exercise the real binary and production ACP adapter | `infra/claude.ts` |
| OpenCode | Not yet implemented; must exercise the real binary and production adapter | `infra/opencode.ts` |
| Pi | Not yet implemented; must exercise the real binary and production ACP adapter | `infra/pi.ts` |

Fixtures and Agent names in controlled tests are not substitutes for these real
acceptance scenarios. Add coverage for supported session continuation, queueing,
streaming/tools, cancellation, interactions, history/files, and relevant identity
or reconnection behavior. State unsupported capabilities explicitly.

## Running

`pnpm test:agent-daemon:real` currently runs the real Codex suite. It requires
Codex CLI 0.154.0 on `PATH` or `MOBIUS_TEST_CODEX_PATH`. Its local model provider is
controlled; it uses no production account, remote model call, or existing session.

The other fixtures resolve real executables through `PATH` or explicit overrides:
`MOBIUS_TEST_CLAUDE_PATH` / `MOBIUS_TEST_CLAUDE_ACP_PATH`,
`MOBIUS_TEST_OPENCODE_PATH`, and
`MOBIUS_TEST_PI_PATH` / `MOBIUS_TEST_PI_ACP_PATH`.
Use versions supported by the production Agent specifications. Missing executables
must fail clearly; never fall back to a fake Agent or silently skip a required case.

`pnpm test:agent-daemon:controlled` runs existing controlled ACP and boundary
fixtures. Keep controlled peers only for explicitly documented protocol faults or
external failures that cannot be reproduced reliably with the real dependency.
They are not the default Agent behavior suite or proof of real compatibility.

Use isolated Agent homes/workspaces, production protocol input, observable output,
event-driven waits, cancellation and finite timeouts. Release all resources on
success, failure, and cancellation. Do not use real sleeps or polling delays.
