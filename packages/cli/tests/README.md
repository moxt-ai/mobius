---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Agent-daemon tests

[Testing](../../../TESTING.md) defines commands and composition entrypoints.
The scenario bodies under [agents](agents/) are the coverage inventory, including
platform-specific `skipIf` conditions. A fixture or permission-response branch
alone is not evidence that a behavior was exercised.

## Running

`pnpm test:agent-daemon:real` runs the files under `agents/`. CI pins
executables and production adapters in [its workflow](../../../.github/workflows/ci.yml).

Put them on `PATH`, or set the fixture overrides below (Codex uses
`MOBIUS_TEST_CODEX_PATH`). Local model providers are controlled; these scenarios
use no production account, remote model call, or existing user session.

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

## Interpreting coverage

A compatibility claim must name an executed scenario, Agent and platform. Live-turn
success does not establish history, file recovery, permission rejection or reconnect
behavior. Check the scenario bodies and their platform conditions before making those
claims; track missing scenarios in issues rather than duplicating a coverage inventory
here. Controlled protocol scenarios do not establish real-Agent compatibility.
