---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Standalone active-history pagination end-to-end verification

- Date: 2026-09-29 (Asia/Shanghai)
- Branch: `codex/live-turn-deltas`
- Browser: Codex in-app browser
- Relay: local Cloudflare Standalone Worker at `http://127.0.0.1:8790`
- Runtime: production Mobius daemon `0.0.148`
- Agent boundary: stateful controlled ACP executable selected as OpenCode

## Behavior slice

After this, a user can keep a Turn with more than one recovery window of text
running, refresh its Web page, and recover every earlier character through
bounded history pages without duplicating the live response.

## Repeatable setup

1. Build the repository's controlled external Agent executable:

   ```sh
   pnpm --filter @moxt-ai/mobius-fake-acp-agent build
   ```

2. Start the Standalone Relay and bundled Web application from this checkout on
   an isolated port. Point Wrangler at a valid local-only `.dev.vars` file; do
   not commit that file.

   ```sh
   pnpm --filter @moxt-ai/mobius-relay-cloudflare-standalone exec \
     wrangler dev --config wrangler.jsonc --port 8790 \
     --env-file packages/relay-cloudflare-standalone/.dev.vars
   ```

3. Expose a test-only `opencode` executable which prints the supported version
   for `--version` and otherwise starts
   `tests/agent-daemon/fixtures/fake-acp-agent/dist/cli.js --agent-name OpenCode`.
   Pair the repository CLI with isolated Runtime and Agent state:

   ```sh
   MOBIUS_STATE_DIRECTORY="$PWD/.mobius/e2e-active-history/state" \
   MOBIUS_OPENCODE_PATH="$PWD/.mobius/e2e-active-history/opencode" \
   MOBIUS_FAKE_ACP_STATE_DIRECTORY="$PWD/.mobius/e2e-active-history/fake-state" \
     node packages/cli/src/cli.ts pair \
       --url http://127.0.0.1:8790 \
       --pairing <pairing-id> \
       --code <one-time-code>
   ```

4. Select OpenCode in a new Web conversation and send the controlled prompt
   `hold after large output`. The Agent emits thirty 10,000-character text
   chunks and keeps the Turn active until cancellation.

## Given / When / Then

Given a fresh Web Session and an online production Runtime, when the controlled
Agent publishes 300,000 `x` characters and the same deep Session URL is opened
again while the Turn remains active, then Web follows every opaque history
cursor, renders exactly 300,000 recovered characters, and does not render the
same live Turn twice.

## Observed browser results

| Check | Verifiable result |
| --- | --- |
| Live Turn | The page remained active and rendered one contiguous 300,000-character response. |
| Live/history reconciliation | The page contained one long text run, not both a 300,000-character live copy and paged history copies. |
| Deep-link refresh | Reopening the same Session URL completed without a history-unavailable message. |
| Earlier text | The refreshed page rendered 128,000 + 128,000 + 44,000 characters, totaling exactly 300,000. |
| Truncation | Both daemon history pages reported `truncated: false`. |

## Captured page contract

The production HTTP route
`POST /mobius/api/v1/projects/standalone/runtimes/:runtimeId/sessions/:sessionId/native-messages`
returned two bounded pages while the Turn was active:

| Page | Accounted characters | Assistant text | Has next cursor | Covered live message IDs |
| ---: | ---: | ---: | --- | --- |
| 0 | 172,008 | 172,000 | yes | none |
| 1 | 128,728 | 128,000 | no | active user and agent messages |

The accumulated assistant text was exactly 300,000 characters. Coverage is
declared only when the oldest active page completes the Turn's recovery range,
allowing Web to retain its live running representation instead of adding a
second historical copy.

## Expected incidental observation

Agent catalog refresh reported an unrelated installed Grok version below its
supported minimum. The selected controlled OpenCode integration was ready and
the tested Session remained available.
