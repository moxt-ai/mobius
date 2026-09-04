#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/worktree/setup.sh [--repair-ports]

Prepare the current checkout for development by allocating its port bundle and
installing the locked workspace dependencies.
EOF
}

PORT_COMMAND=ensure
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repair-ports)
      PORT_COMMAND=repair
      ;;
    --)
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unsupported argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

REPOSITORY_ROOT=$(git rev-parse --show-toplevel)
cd "$REPOSITORY_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to set up a Mobius worktree." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to set up a Mobius worktree." >&2
  exit 1
fi

echo "Preparing Mobius development ports..."
node scripts/worktree/port-allocator.mjs "$PORT_COMMAND"

echo "Installing workspace dependencies..."
pnpm install --frozen-lockfile

echo ""
echo "Mobius worktree is ready: $REPOSITORY_ROOT"
node scripts/worktree/port-allocator.mjs validate
echo "Start the hot-reload stack with: pnpm dev:stack"
