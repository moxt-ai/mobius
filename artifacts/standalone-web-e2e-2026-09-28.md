---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Standalone Web end-to-end verification

- Date: 2026-09-28 (Asia/Shanghai)
- Base commit: `5888b1dc393c6aed20abfe1b4c30f48fab226acc`
- Browser: Codex in-app browser
- Relay: local Cloudflare Standalone Worker at `http://127.0.0.1:8787`
- Controlled Runtime: production Mobius daemon with the real Codex CLI `0.153.0`
- Live Runtime: production Mobius daemon with the user-authenticated Codex CLI `0.156.1`
- Model boundaries: the repository's deterministic provider, followed by the user's live Codex provider

## Repeatable setup

1. Put a local test token in `packages/relay-cloudflare-standalone/.dev.vars` as
   `MOBIUS_STANDALONE_TOKEN=<local-test-token>`.
2. Start the Relay and bundled Web application:

   ```sh
   pnpm dev:cloudflare:standalone
   ```

3. Start a production daemon with a real Codex binary and the deterministic provider:

   ```sh
   MOBIUS_TEST_CODEX_PATH=/absolute/path/to/codex \
     pnpm dev:agent codex --daemon -- __manager
   ```

4. Open `http://127.0.0.1:8787/`, create a pairing, and run the displayed pairing
   command against the daemon state directory created by `dev:agent`.

## Given / When / Then

Given a fresh Standalone Worker database, a paired online Runtime, and the real Codex
ACP adapter, when the browser creates a new chat, sends two turns, reloads the deep
link, and opens the Runtime management surfaces, then the same native Codex session is
restored and every tested surface remains usable without a protocol error.

## Observed results

| Check | Verifiable result |
| --- | --- |
| Pairing | Runtime became `Online` and exposed the verified Codex integration. |
| New Session | Browser-created ID used the `web-` prefix and prepared as a new Mobius Session. |
| First prompt | `Reply with exactly: standalone smoke pass` completed through the production daemon and real Codex CLI. |
| First response | `Response from Codex through the local fake provider: plain response` rendered in the chat. |
| Deep-link reload | The first user and assistant messages reloaded from Runtime native history. |
| Continued turn | `Reply with exactly: restored follow-up pass` completed in the restored Session. |
| Second reload | Both user prompts and both assistant responses reloaded; no `invalid_protocol_message` appeared. |
| Unknown Session | `/sessions/web-missing-check` showed `Session unavailable` and did not expose another Session's history. |
| Run settings | Restored values rendered as `GPT-5.6-Sol`, `Low`, `Build`, and `Full access`. |
| Local sessions | Codex native-session discovery listed the created Session with its title and workspace. |
| Local machines | The current Runtime appeared once as `Online` with Codex available. |
| Agent settings | Codex appeared under `Ready to use` with version `codex-cli 0.153.0`. |
| Standalone navigation | The unsupported legacy channel-access entry was absent because Standalone uses a Project credential. |

Observed Session:
`web-faf121a7-6c7b-471d-b5de-1575fb2958e6`

## Live provider verification

The controlled provider was stopped before this scenario. The same Mobius state
directory and Runtime pairing were then started without the fixture's `CODEX_HOME`,
API key, or provider endpoint overrides:

```sh
codex login status

MOBIUS_STATE_DIRECTORY="$PWD/.mobius/dev-agents/codex" \
  node packages/cli/src/cli.ts quit

env -u CODEX_HOME -u CODEX_API_KEY -u OPENAI_API_KEY \
  -u DEFAULT_AUTH_REQUEST \
  MOBIUS_STATE_DIRECTORY="$PWD/.mobius/dev-agents/codex" \
  MOBIUS_CODEX_PATH=/absolute/path/to/codex \
  node packages/cli/src/cli.ts __manager
```

`codex login status` reported `Logged in using ChatGPT`, the production Agent probe
reported Codex `ready`, and the saved Standalone Runtime returned to `online`.

| Check | Verifiable result |
| --- | --- |
| Provider isolation | The fake-provider daemon and its temporary provider environment exited before the live daemon started. |
| Live prompt | `Reply with exactly: REAL_PROVIDER_OK_20260928` was sent from the in-app browser. |
| Live response | Codex returned exactly `REAL_PROVIDER_OK_20260928`, rather than the deterministic fake-provider response. |
| Live history reload | A full browser reload restored both the live user prompt and live Codex response from Runtime native history. |

Live Session:
`web-1e390087-c0c3-48c2-8d89-bd6f5deba414`

The local Codex configuration emitted warnings for two ignored provider settings and
for unavailable optional MCP servers. These warnings did not prevent authentication,
model completion, or history restoration.

## Production deployment verification

- Origin: `https://mobius-standalone.moxt.ai`
- Worker: `mobius-standalone-production`
- Cloudflare deployment: `03651d4b-4320-43ce-81b6-8c4a9388a8a5`
- Database: dedicated production D1 database with all committed migrations applied
- Browser: Codex in-app browser
- Runtime: repository CLI `0.0.145` and the user-authenticated local Codex Agent

Given the new production Worker, an empty production D1 database, and no existing
Runtime, when the in-app browser loaded the custom domain, created a one-time pairing,
paired the repository CLI, sent a prompt to the real Codex Agent, and reloaded the
deep Session URL, then the Runtime stayed online and native history restored through
the public deployment.

| Check | Verifiable result |
| --- | --- |
| Custom domain | `/` returned the production Web document with title `Mobius Agent Chat`. |
| Static assets | The hashed JavaScript asset returned HTTP 200 from Cloudflare. |
| Worker and D1 | An unknown pairing read returned HTTP 404 with `pairing_not_found`, proving the API route reached the migrated D1-backed Worker. |
| Browser pairing | The production page created a one-time pairing and advanced automatically after CLI redemption. |
| Runtime transport | `Mac-Studio.local` changed from `Connecting` to `Runtime online`. |
| Agent discovery | The composer loaded the real Codex settings (`GPT-5.6-Sol`, `High`). |
| Live prompt | `Reply exactly with: STANDALONE_REMOTE_E2E_OK` was sent through the production origin. |
| Live response | Codex returned exactly `STANDALONE_REMOTE_E2E_OK`. |
| Deep-link reload | Direct navigation to the Session URL restored the user message, Codex response, Runtime status, and two-entry Session list. |

Production Session:
`https://mobius-standalone.moxt.ai/projects/standalone/runtimes/rnt_8avmQEDwDO8vFUP5v5sqd8Wf/sessions/web-94215d9e-966e-4363-9320-6e95d11ec0d3`

To repeat the production check, open the origin in a fresh browser profile, run the
displayed `mobius pair` command, wait for `Runtime online`, send a uniquely identifiable
prompt, and reload the resulting deep Session URL. Do not reuse an expired pairing code.

## Repository verification

```sh
pnpm lint
pnpm typecheck
pnpm test:integration:standalone
pnpm --filter @moxt-ai/mobius-relay-cloudflare-standalone build
MOBIUS_TEST_CODEX_PATH=/absolute/path/to/codex \
  pnpm exec vitest run --config vitest.agent-daemon.config.ts \
  tests/agent-daemon/real/codex-live-turn.integration.test.ts --maxWorkers=1
```

All four commands passed. The Vite build reports its existing large-chunk warning;
Wrangler completed the dry-run bundle with the Web assets included.
