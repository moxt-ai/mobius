---
name: mobius-worktree-development
description: Create, reuse, repair, reset, or safely remove repository-managed Mobius development worktrees. Use when a user asks an agent to do Mobius work in an isolated worktree, manage a worktree branch, resolve its development-port setup, or clean up a managed worktree. Use the repository pnpm commands and never invoke Quack.
---

# Mobius Worktree Development

Use the repository-owned worktree workflow. Do not invoke Quack and do not
reimplement the workflow with direct `git worktree` or hand-edited port files.

## Establish the target

Confirm the checkout belongs to Mobius with `git rev-parse --show-toplevel`,
then inspect `git status --short` and the current worktree list. If the user
already selected a worktree, keep using it. Create another one only when the
request calls for isolated work and no target worktree was supplied.

When behavior may have changed, inspect the current scripts in
`scripts/worktree/` and the `worktree:*` entries in `package.json` before acting.
The repository implementation is authoritative over this skill.

## Create or reuse

From any Mobius checkout, run:

```bash
pnpm run worktree:new -- <name>
```

Omit `<name>` only when a generated name is acceptable. The command fetches the
latest `origin/main`, creates `.worktrees/<name>` on `worktree/<name>`, or
reopens the retained local branch when it already exists. It allocates a stable
Relay/Web port bundle and installs locked dependencies.

Read the checkout path printed by the command and use that absolute path as the
working directory for all subsequent task commands. Do not assume that changing
directory in one shell call affects later calls.

After creation, verify the generated claim:

```bash
pnpm worktree:ports
```

Do not source or edit `.env.worktree`. Vite and local Wrangler read it through
the repository's validated loader.

## Develop and verify

Run ordinary repository commands inside the selected worktree. Start the local
hot-reload stack only when the task requires runtime testing:

```bash
pnpm dev:stack
```

Use the Web port reported by `pnpm worktree:ports` for browser checks. Stop all
development processes when verification finishes. Run the task-specific checks
and `pnpm check` before a pull request, following `TESTING.md` and repository
instructions.

Creating a worktree does not authorize committing, pushing, opening a pull
request, deleting a worktree, or changing an existing branch's history. Perform
those actions only when the user's request includes them.

## Recover setup

Inspect the current claim with `pnpm worktree:ports`. If its configuration is
missing, invalid, or conflicting, first stop the worktree's development servers,
then run:

```bash
pnpm worktree:repair-ports
```

To restore both the port claim and locked dependencies while preserving source
changes, use:

```bash
pnpm worktree:reset
```

Never bypass a running-port refusal. Identify and stop the owning development
process, then retry. Do not force a new claim while the old services are live.

## Remove safely

Delete a managed worktree only when the user asks. The worktree must be clean
and its managed ports must be stopped. From inside the target worktree, run:

```bash
pnpm run worktree:delete
```

From the main checkout, pass the managed directory name:

```bash
pnpm run worktree:delete -- <name>
```

The command removes only `.worktrees/<name>` and retains the local branch. Never
force deletion or delete the retained branch unless the user explicitly asks.

If the repository commands are missing or fail before establishing a safe
target, stop and report the evidence. Do not fall back to Quack or a destructive
manual workaround.
