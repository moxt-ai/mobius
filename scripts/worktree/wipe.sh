#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Reset HEAD and tracked files to the latest origin/main, then
# re-initialize the worktree environment. Local commits stay reachable
# through reflog until garbage collection.

git fetch --prune origin
git reset --hard origin/main

exec scripts/worktree/reset.sh
