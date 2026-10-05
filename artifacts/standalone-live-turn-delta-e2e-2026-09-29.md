---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Standalone live-turn delta end-to-end verification

- Date: 2026-09-29 (Asia/Shanghai)
- Branch: `codex/live-turn-deltas`
- Browser: Codex in-app browser
- Relay: local Cloudflare Standalone Worker at `http://127.0.0.1:8787`
- Runtime: production Mobius daemon `0.0.148`
- Agent: user-authenticated Codex CLI `0.156.1`

## Behavior slice

After this, a user can run a long-lived Codex turn without receiving a growing
full-turn snapshot on every update, refresh the browser while the turn is active,
and see the conversation recover and continue from bounded live events.

## Repeatable setup

1. Put a local-only test token in
   `packages/relay-cloudflare-standalone/.dev.vars`:

   ```text
   MOBIUS_STANDALONE_TOKEN=<local-test-token>
   ```

2. Start the Standalone Relay and bundled Web application:

   ```sh
   pnpm dev:cloudflare:standalone
   ```

3. Open `http://127.0.0.1:8787/` in a browser and run the displayed one-time
   pairing command with the repository CLI. Use an isolated state directory so
   the test cannot reuse an older Runtime:

   ```sh
   MOBIUS_STATE_DIRECTORY="$PWD/.mobius/e2e-live-turn" \
     node packages/cli/src/cli.ts pair \
     --url http://127.0.0.1:8787 \
     --pairing <pairing-id> \
     --code <one-time-code>
   ```

4. In browser DevTools, enable the Network domain and retain WebSocket frames
   across the test. Decode the JSON string in each outer `session.event.payload`
   before asserting the inner `kind`.

## Given / When / Then

Given a fresh Standalone database, a paired production Runtime, and a real Codex
Agent, when the browser sends a normal turn and then a turn that executes
`sleep 12`, refreshes while that command is running, waits for completion, and
reloads the completed Session again, then live updates remain incremental and
both active and completed history recover correctly.

## Observed browser results

| Check | Verifiable result |
| --- | --- |
| Pairing | The new Runtime became `Runtime online`; the composer loaded Codex settings. |
| Normal live turn | The browser rendered `LIVE_DELTA_E2E_OK_20260929`. |
| Active-turn precondition | Before refresh, the page showed `Agent is working`; WSS carried a running `agent.activity` for `/bin/zsh -lc 'sleep 12'`. |
| Active refresh | A full page reload kept the same deep Session URL and restored both prompts plus the earlier response. |
| History source | Reload issued `GET .../native-messages`; every observed response was HTTP 200. |
| Continued live stream | After reload, WSS delivered the completed tool activity, two `agent.message.delta` frames, and `session.completed`. |
| Reconciled result | The page rendered the expected completion text followed by `ACTIVE_REFRESH_E2E_OK_20260929`. |
| Completed reload | A second full reload restored both user prompts and both Codex replies under `Previous conversation history`; no working indicator remained. |

## Captured protocol assertions

Thirteen outer `session.event` frames were captured during the two turns and the
active-page reload. Their decoded inner kinds were:

| Inner kind | Count | Largest captured outer frame |
| --- | ---: | ---: |
| `agent.message.delta` | 4 | 429 bytes |
| `agent.activity` | 4 | 1,197 bytes |
| `agent.activity.narration` | 1 | 381 bytes |
| `session.started` | 1 | 534 bytes |
| `session.completed` | 2 | 266 bytes |
| `session.ready` | 1 | 5,238 bytes |
| `session.turn.updated` | **0** | n/a |

The first response arrived as two distinct text deltas. The post-refresh response
also arrived as two distinct text deltas, splitting the final marker between the
frames. No captured live frame contained a cumulative turn snapshot.

## Expected incidental observation

The initial local-agent recheck reported an unrelated installed Grok `1.0.13`
below its supported minimum. The selected Codex integration remained ready and
both real Codex turns completed. This warning happened before Session creation and
did not affect the live-turn protocol assertions.
