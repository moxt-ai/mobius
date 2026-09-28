# Standalone Session List E2E — 2026-09-28

## Behavior

After this change, a user can refresh Standalone Web and see prompted conversations from the paired local Runtime, then open one and see its Agent-native history.

The Relay remains stateless for Session directory and content. It requests metadata from the authenticated Runtime over the control channel. The selected Session history is loaded separately from that Runtime.

## Repeatable automated scenario

```bash
pnpm vitest run tests/runtime-session-directory.contract.test.ts --maxWorkers=1
```

Scenario:

- Given the production daemon is paired to an isolated local Platform and a controlled ACP Agent has a prompted conversation.
- When the public SDK lists that Runtime's Sessions through `GET /mobius/api/v1/projects/:projectId/runtimes/:runtimeId/sessions?limit=100`.
- Then the Runtime returns `session.listed` with that prompted Session's normalized metadata.

Observed result: 1 test passed.

## Real browser scenario

Environment:

- Web/Relay: `http://127.0.0.1:8787`
- CLI: `0.0.146`, run from this checkout
- Runtime: `rnt_rJhFCv8_TSMTSEsHj7Xo2Cq-`
- Session: `web-session-list-33586615-7348-4141-98f4-c19c5135489e`
- Agent: real local Codex provider

Steps and observed results:

1. Paired the source CLI to the local Standalone Worker.
2. Created and prompted the Session with `Reply with exactly: SESSION_LIST_REFRESH_OK_20260928`.
3. Refreshed the Web on a different, unprompted draft Session.
4. The sidebar restored one persisted conversation titled `Reply with exactly: SESSION_LIST_REFRESH_OK_20260928` from the Runtime directory.
5. Opened the restored Session and observed both the prior user prompt and exact Agent response `SESSION_LIST_REFRESH_OK_20260928`.
6. Refreshed that deep link again. The same sidebar entry and both history messages were restored.

## Other verification

```bash
pnpm lint
pnpm typecheck
pnpm test:ci:client
pnpm test:integration:standalone
pnpm vitest run packages/protocol/tests packages/mobius-sdk/tests --maxWorkers=4
pnpm --filter @moxt-ai/mobius-web build
```

Observed results:

- lint and architecture checks passed
- all workspace typechecks passed
- controlled Agent suite: 131 passed
- client contract group, including the Runtime Session directory: 37 passed
- Standalone integration: 1 passed
- Protocol/SDK contracts: 36 passed
- Web production build passed
