#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT=$(git rev-parse --show-toplevel)
cd "$REPOSITORY_ROOT"

exec bash scripts/worktree/setup.sh --repair-ports
