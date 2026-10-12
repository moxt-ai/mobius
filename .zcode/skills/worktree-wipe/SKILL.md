---
name: worktree-wipe
description: Reset the current worktree's HEAD, tracked files and local commits to the latest origin/main, then re-initialize the environment. Use when the user says "wipe worktree" or asks to discard worktree changes and reset it.
user-invocable: true
allowed-tools: Bash(git:*), Bash(scripts/worktree/*:*)
---

# Worktree Wipe

Run `git fetch --prune origin`, then show:

- `git status --short --branch`;
- `git log --oneline origin/main..HEAD`.

Use `AskUserQuestion` to confirm, and state clearly that:

- the current HEAD moves to the latest `origin/main`; if HEAD is
  attached to a local branch, that branch pointer moves too;
- local commits are no longer referenced by the current HEAD and
  tracked-file changes are discarded;
- ordinary untracked files are not cleaned, but `.env` and
  `packages/relay-cloudflare-standalone/.dev.vars` are deleted;
- Git content may still be recoverable through reflog; never claim all
  content is permanently unrecoverable.

If the user cancels, stop immediately. After confirmation, run
`scripts/worktree/wipe.sh`.

Report completion only after the command succeeds; on failure, report
the original error and the current Git status.
