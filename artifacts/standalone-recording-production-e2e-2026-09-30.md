# Standalone Recording production E2E — 2026-09-30

## Behavior

After today's changes, every fresh Standalone pairing creates an independent Project.
Recording remains disabled by default and can be enabled for that Project before the
pairing begins. An enabled Project restores parent and forked Session histories from
Recording while the local Runtime is offline. A disabled Project continues to load
history from the local daemon and reports the Runtime as unavailable when that daemon
is offline.

## Production setup

- Origin: `https://mobius-standalone.moxt.ai`
- CLI: `npx --yes @moxt-ai/mobius@latest` (`0.0.152`)
- Real Agent: Claude Code
- Recording-enabled Project: `prj_W6q7Ju-oqBxFi7Ts-7epeNJE`
- Recording-disabled Project: `prj_jWG2q0zzx8shgpE8eg1U447I`

The distinct Project IDs were created by separate first-pairing workflows and prove
that Standalone no longer reuses a deployment-wide Project.

## Recording-enabled fork scenario

Parent Session:

<https://mobius-standalone.moxt.ai/projects/prj_W6q7Ju-oqBxFi7Ts-7epeNJE/runtimes/rnt_dbkb7fDEbx9xEUrR1cL2sSX7/sessions/web-accedb45-bb68-494d-aee7-e4e8c394ec8c>

Forked child Session:

<https://mobius-standalone.moxt.ai/projects/prj_W6q7Ju-oqBxFi7Ts-7epeNJE/runtimes/rnt_dbkb7fDEbx9xEUrR1cL2sSX7/sessions/5cefeb14-86c8-4764-ac44-8b178e7f838b>

Repeatable sequence:

1. Enable Recording during first pairing and pair with the latest CLI.
2. In the parent, complete `PARENT_TURN_ONE_20260930` and
   `PARENT_TURN_TWO_20260930`.
3. Fork after the second completed Turn.
4. Complete `CHILD_TURN_ONE_20260930` in the child.
5. Return to the parent and complete `PARENT_AFTER_FORK_20260930`.
6. Stop the daemon with `npx --yes @moxt-ai/mobius@latest quit`.
7. Reload both Session URLs.

Observed while the Runtime was offline:

- The parent restored both pre-fork Turns and `PARENT_AFTER_FORK_20260930`.
- The parent did not contain `CHILD_TURN_ONE_20260930`.
- The child restored both pre-fork parent Turns and `CHILD_TURN_ONE_20260930`.
- The child did not contain `PARENT_AFTER_FORK_20260930`.
- The sidebar listed both Sessions from the Recording directory.

This verifies the recorded Turn projection, `throughCommandId` prefix boundary,
independent parent/child continuation, directory projection, and offline history read.

## Recording-disabled compatibility scenario

Session:

<https://mobius-standalone.moxt.ai/projects/prj_jWG2q0zzx8shgpE8eg1U447I/runtimes/rnt_znWEb4ur_sPwIJ3PbEGarPd1/sessions/web-0daacf15-c42b-4b49-84c8-00b5b940e22f>

Repeatable sequence:

1. Leave Recording at its default disabled value and continue first pairing.
2. Pair with the latest CLI and complete `RECORDING_DISABLED_ONLINE_20260930`.
3. Reload while the daemon is online; the Claude Code history is restored by the
   daemon.
4. Stop the daemon and reload again.

Observed result: Web showed `runtime_offline: The Runtime connection closed` and did
not load the Session through Recording.

## Repository verification

```sh
pnpm lint
pnpm typecheck
pnpm test:integration:recording
pnpm test:integration:standalone
pnpm test:ci:client
pnpm test:integration:platform
```

Results:

- Lint and typecheck passed.
- Recording Worker integration: 6/6 passed.
- Standalone integration: 4/4 passed.
- Protocol, SDK, and Runtime directory contracts: 45/45 passed.
- Platform integration: 14/14 passed.
- The first controlled daemon run passed 130/132 and timed out in two files. Both
  timed-out files passed immediately when rerun alone: interaction snapshot 2/2 and
  manager version compatibility 4/4. These were timeout flakes rather than assertion
  failures.

## Product boundary found

The Recording protocol and Worker accept a fork boundary identified by
`throughCommandId`, but the current Web UI only exposes the fork action on the most
recent completed Turn. An arbitrary older Turn therefore cannot currently be selected
through the production UI.
