# Standalone multi-tab active Turn E2E — 2026-09-29

## Scenario

Given a paired standalone Web session backed by the production Relay, daemon, transports, and the stateful controlled ACP executable,
when browser tab A starts `release after first delta`, tab B opens the same deep link after the first text/content deltas, and the controlled Agent is then released,
then both tabs must show the same running state while the Turn is active and retain the complete response and content after it completes.

## Pre-fix observation

- Tab A showed `RUNNING`, `Partial reply`, `partial.bin`, `Working`, and `Stop agent`.
- Tab B opened mid-Turn and recovered the same running state, text, and content.
- After release, tab A showed `Partial reply and more` and `partial.bin`.
- After release, tab B left the running state but regressed to the terminal Agent-native fragment `and more`, losing the already recovered prefix and content.

The first terminal-overlay run retained `Partial reply and more` but exposed a second handoff defect: the Agent-native `user + and more` fragment and the daemon overlay were both rendered. The native portion for the matching latest user Turn must be replaced, not prepended.

The running-state comparison also showed that the recovery payload contained `partial.bin`, while the native-history presentation rendered only text and images. Rich `content` therefore needed to be rendered by the same history surface.

This is the failing browser scenario that owns the terminal handoff behavior. The final verification section will be appended after the fix is exercised through a new session.

## Final verification

- Runtime: `rnt_a5R4IsdqDRAMI5xx9S8R8GAb`
- Session: `web-e4b6dbcd-ee36-498a-8cdd-ce2e4c6b2dfb`
- Tab A opened the Turn through the production Web prompt entrypoint.
- Tab B opened the same deep link only after A displayed the first delta.
- While running, both tabs showed the session under `RUNNING`, the prompt `release after first delta`, the recovered text `Partial reply`, `partial.bin`, `Working`, and `Stop agent`.
- After the controlled Agent was released, both tabs left `RUNNING` and showed exactly one user prompt plus the complete `Partial reply and more` response.
- Tab B was reloaded after completion and still showed exactly one prompt, the complete response, and `partial.bin` from the recovered rich content.
- A native-history convergence regression was also checked separately: once Agent-native history contains the complete terminal text and rich content, the daemon stops applying the overlay and preserves the Agent-native activity timeline.
- No direct store access, request interception, or test-only internal bypass was used. The run used the standalone Web, production Relay and daemon transports, and the repository's stateful controlled ACP executable.

Result: pass.
