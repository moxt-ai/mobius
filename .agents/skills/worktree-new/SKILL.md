---
name: worktree-new
description: Create a new git worktree under .worktrees/ and report its path. Use when the user says "create a worktree", "new worktree", "open a new worktree", or asks to start work in an isolated worktree.
user-invocable: true
allowed-tools: Bash(scripts/worktree/*:*)
---

# Worktree New

Run the command in the foreground and wait for it to finish:

- No name given: `scripts/worktree/new.sh --json`
- User provides a name: `scripts/worktree/new.sh --json "<worktree-name>"`

The command prints exactly one JSON object on stdout at the end:

```json
{"branch":"owner/name","path":"/absolute/path","reused":false}
```

The project scripts handle the shared Git lock, idempotent reuse of a
same-name worktree, atomic port registration in `.env.worktree`, and
`pnpm install`. Reuse reports `"reused":true`.

After the command succeeds, report `branch`, `path` and `reused`. The
session working directory does not follow the new worktree, so run any
follow-up command with the worktree as its working directory, for
example `cd "<worktree path>" && <command>`.

If the command fails, report the original error and never report
success.
