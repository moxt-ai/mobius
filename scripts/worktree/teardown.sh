#!/usr/bin/env bash
set -euo pipefail

# Switch to the repository root
cd "$(git rev-parse --show-toplevel)"

error() { echo -e "ERROR: $1" >&2; }
success() { echo "OK: $1"; }

echo "Cleaning up worktree..."
echo ""

# Stop any listeners on the ports claimed by this worktree, then release
# the port claim so the bundle becomes available to other worktrees.
if ! node scripts/worktree/port-allocator.mjs terminate; then
  error "Failed to terminate worktree port listeners"
  exit 1
fi

if [ -f .env.worktree ]; then
  if [ -f .env.worktree ] && rm .env.worktree; then
    success "Removed .env.worktree"
  fi
fi

if [ -f .env ]; then
  rm .env
  success "Removed .env"
fi

if [ -f packages/relay-cloudflare-standalone/.dev.vars ]; then
  rm packages/relay-cloudflare-standalone/.dev.vars
  success "Removed packages/relay-cloudflare-standalone/.dev.vars"
fi

success "Worktree cleanup finished"
