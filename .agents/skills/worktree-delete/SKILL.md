---
name: worktree-delete
description: Delete the current worktree, or a named worktree under .worktrees/ from the main repository. Use when the user says "delete worktree", "remove this worktree", or asks to run delete-worktree.
user-invocable: true
allowed-tools: Bash(git:*), Bash(scripts/worktree/*:*)
---

# Worktree Delete

Resolve the target's absolute path before deleting. When running in the
main repository and the user did not provide a directory name under
`.worktrees/`, ask for it first. Run
`git -C "<target-path>" status --short --branch` and show the user the
target path, its branch, and all uncommitted and untracked files.

Use `AskUserQuestion` to confirm, and state clearly that:

- the worktree directory and everything uncommitted or untracked inside
  it will be deleted;
- the claimed port bundle is released back to the shared allocator;
- existing local Git branches are NOT deleted.

If the user cancels, stop immediately. After confirmation, run:

- From inside the target worktree: `scripts/worktree/delete.sh`
- From the main repository: `scripts/worktree/delete.sh "<worktree-directory-name>"`

Report the deletion result only after the command succeeds. After
deleting from inside the target worktree, remind the user that the
current working directory no longer exists.
