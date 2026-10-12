---
name: worktree-reset
description: Re-initialize the current worktree environment while keeping Git working tree changes. Use when the user says "reset worktree" or asks to re-initialize a worktree.
user-invocable: true
allowed-tools: Bash(scripts/worktree/*:*)
---

# Worktree Reset

Before running, explain the impact:

- No `git reset` or `git clean` is run; existing source changes and the
  claimed port bundle are preserved;
- `.env` and `packages/relay-cloudflare-standalone/.dev.vars` are
  deleted;
- dev services must already be stopped, otherwise the command fails at
  the `assert-stopped` check.

Use `AskUserQuestion` to confirm. If the user cancels, stop
immediately; after confirmation, run `scripts/worktree/reset.sh` in the
background.

Once started, only report that the background task has begun; never
claim initialization is already done. When the background task
notification arrives, check the exit status: report success, or report
the original error on failure. Do not run commands that depend on the
worktree environment before completion.
