# Agent-daemon integration tests

## Ownership

These tests cover the real local daemon together with each real Agent and its
production adapter. Web / Chat tests independently use the production daemon with
a controlled Agent harness; they do not test Agent adapter compatibility. See
[the testing guide](../../TESTING.md) for the shared boundary contract.

Use separate Agent scenarios because native APIs, adapters, history, cancellation,
interactions, and session identity may differ. Share only common fixture plumbing.
The real Agent must execute tools and own its native session history. A controlled
model provider can make its output deterministic without replacing the Agent.

## Current coverage and gaps

| Agent | Real daemon acceptance coverage | Existing fixture |
| --- | --- | --- |
| Codex | Real app-server: streaming/tools, FIFO and queue cancellation, execution snapshots, history/files; native creation, active cancellation and queued continuation; continuation and history after process-capacity eviction | `infra/codex.ts` |
| Claude Code | Real binary and production ACP adapter: shell tool, continued streamed reply, native creation, active cancellation and queued continuation | `infra/claude.ts` |
| OpenCode | Real binary and production adapter: shell tool, continued streamed reply, native creation, active cancellation and queued continuation | `infra/opencode.ts` |
| Pi | Real binary and production ACP adapter: shell tool, continued streamed reply, native creation, active cancellation and queued continuation | `infra/pi.ts` |

Each Agent has its own `real/<agent>-native-recovery.integration.test.ts`.
These scenarios create a native session through the daemon, complete a first
prompt, hold the next model response, enqueue another prompt, cancel the active
prompt, and observe the queued reply completing in that same native session.
Provider gates are event-driven; no sleep or timing tolerance controls the race.
`real/codex-process-capacity.integration.test.ts` additionally exceeds the retained
process capacity, continues the original session, and reads both turns from native
history through the daemon protocol.

Real history/file and capacity coverage is currently Codex-specific. Real
permissions/interactions and reconnect coverage across all four Agents remain
separate gaps; controlled protocol tests do not close those gaps.

Fixtures and Agent names in controlled tests are not substitutes for these real
acceptance scenarios. Add coverage for supported session continuation, queueing,
streaming/tools, cancellation, interactions, history/files, and relevant identity
or reconnection behavior. State unsupported capabilities explicitly.

## Running

`pnpm test:agent-daemon:real` runs ten scenarios across the four real Agents. CI installs pinned
executables and production adapters:

- Codex CLI 0.154.0;
- Claude Code 2.1.273 and claude-agent-acp 0.73.0;
- OpenCode 1.18.29;
- Pi 0.85.0 and pi-acp 0.0.33.

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

## Controlled scenario organization

- `native-session-identity`: assigned/native identity, restart, import, and fork integrity.
- `native-session-preparation`: shared preparation, shutdown, and exclusive-writer races.
- `native-session-history`: bounded previews, pagination, and capability differences.
- `native-session-authorization`: directory authorization, lookup, and unsupported capabilities.
- `codex-native-commands`: app-server command and unavailable-model responses.
- `acp-commands-environment`: advertised commands and process environment propagation.
- `acp-content-limits`: large output, media shapes, and repeated tool identities.
- `acp-usage`: reported, absent, malformed, and Agent-specific usage formats.
- `acp-interactions`: targeted steering, permissions, and elicitation correlation.

Fixture modules only create disposable peers and observers; they do not register
scenarios. Real Agent tests own normal first-prompt, continuation, cancellation
recovery, and FIFO queue behavior. Controlled restart/history cases remain where
they exercise distinct native ID formats, loading capabilities, or file layouts;
they do not establish real Agent compatibility.

## Coverage retained after duplicate pruning

- Real Codex native recovery and process-capacity scenarios own ordinary discovery,
  continuation and native listing. Controlled discovery keeps missing/unsupported
  executables, authentication, backend exit and path-resolution failures.
- The installation journey covers an absent Codex becoming available and verified;
  a second already-installed Codex success scenario is unnecessary. Managed download
  integrity, environment proxying, catalog refresh and installation-state isolation
  remain independent risks.
- Controlled native identity/history scenarios retain Codex's app-server path,
  Claude's ACP path and OpenCode's distinct native ID shape. A Pi label on the same
  ACP peer adds no coverage. Real Pi scenarios remain independent compatibility tests;
  real non-Codex history coverage is still a gap.
- Token bursts assert complete output before successful completion, without fixing
  the number of network snapshots. Large active-turn recovery, cancellation, steering,
  narration and interaction snapshots remain covered.
- Settings/model translation, backend faults, compact commands, exclusive history
  writers, fork identity and authorization stay controlled until another production
  boundary proves those same risks.

Protocol success round trips for event envelopes, prompt queue/steer, cancellation,
installation, session preparation and workspace listing are exercised by daemon,
SDK or hosting integrations. Contract tests retain rejection cases and rich payload
shapes not otherwise fully asserted. Resource-model contracts remain because their
public record variants do not all have equivalent integration coverage.
