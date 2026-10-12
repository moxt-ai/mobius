#!/usr/bin/env bash
set -euo pipefail

# Switch to the repository root
cd "$(git rev-parse --show-toplevel)"

error() { echo -e "ERROR: $1" >&2; }
success() { echo "OK: $1"; }

echo "Initializing worktree..."
echo ""

# Allocate or preserve the worktree port bundle in .env.worktree
if ! node scripts/worktree/port-allocator.mjs ensure; then
  error "Failed to allocate worktree ports"
  exit 1
fi

# Install workspace dependencies. pnpm keeps a single shared store, so
# per-worktree node_modules are hard links and do not duplicate packages.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (pnpm install)..."
  if ! pnpm install; then
    error "pnpm install failed"
    exit 1
  fi
  success "Dependencies installed"
else
  echo "Skip: node_modules already present"
fi

echo ""
echo "==============================================================================="
echo "  Worktree base environment is ready at:"
echo "     $(pwd)"
echo ""
echo "  Port configuration lives in .env.worktree:"
echo "     source .env.worktree before starting services"
echo ""
echo "  Common commands:"
echo "     pnpm dev                        # Platform Worker + Web dev server"
echo "     pnpm dev:cloudflare:standalone  # Standalone Worker"
echo "     pnpm dev:cli                    # CLI dev watch"
echo "==============================================================================="
echo ""
