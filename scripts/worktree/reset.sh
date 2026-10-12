#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Re-initialize the worktree environment while keeping Git working tree
# changes: stop listeners, release and re-claim ports, reinstall basics.
# Requires the worktree services to be stopped first.

node scripts/worktree/port-allocator.mjs assert-stopped
node scripts/worktree/port-allocator.mjs repair
scripts/worktree/teardown.sh
scripts/worktree/setup.sh
