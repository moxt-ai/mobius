#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm run worktree:delete -- [directory-name]

Run without an argument from a managed worktree, or pass its .worktrees
directory name while in the main checkout. Development servers must be stopped
and tracked changes must be clean. The local branch is retained.
EOF
}

error() {
  echo "Worktree deletion failed: $1" >&2
}

find_registered_worktree() {
  local expected_path=$1
  local line
  while IFS= read -r line; do
    case "$line" in
      "worktree $expected_path")
        printf '%s\n' "$expected_path"
        return 0
        ;;
    esac
  done < <(git -C "$REPOSITORY_ROOT" worktree list --porcelain)
  return 1
}

WORKTREE_DIRECTORY_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      error "unsupported argument: $1"
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$WORKTREE_DIRECTORY_NAME" ]]; then
        error "only one worktree directory name can be specified"
        usage >&2
        exit 2
      fi
      WORKTREE_DIRECTORY_NAME=$1
      ;;
  esac
  shift
done

GIT_COMMON_DIRECTORY=$(git rev-parse --path-format=absolute --git-common-dir)
REPOSITORY_ROOT=$(dirname "$GIT_COMMON_DIRECTORY")
CURRENT_WORKTREE=$(git rev-parse --show-toplevel)

if [[ -n "$WORKTREE_DIRECTORY_NAME" ]]; then
  if [[ "$CURRENT_WORKTREE" != "$REPOSITORY_ROOT" ]]; then
    error "a directory name can be passed only from the main checkout"
    exit 2
  fi
  if [[ ! "$WORKTREE_DIRECTORY_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    error "the directory name is invalid"
    exit 2
  fi
  WORKTREE_PATH="$REPOSITORY_ROOT/.worktrees/$WORKTREE_DIRECTORY_NAME"
else
  WORKTREE_PATH=$CURRENT_WORKTREE
fi

case "$WORKTREE_PATH" in
  "$REPOSITORY_ROOT/.worktrees/"*) ;;
  *)
    error "only worktrees managed under $REPOSITORY_ROOT/.worktrees can be deleted"
    exit 1
    ;;
esac

if ! find_registered_worktree "$WORKTREE_PATH" >/dev/null; then
  error "no registered worktree exists at $WORKTREE_PATH"
  exit 1
fi
if [[ -n "$(git -C "$WORKTREE_PATH" status --porcelain)" ]]; then
  error "tracked or untracked changes are present; commit, move, or remove them first"
  exit 1
fi

(
  cd "$WORKTREE_PATH"
  node scripts/worktree/port-allocator.mjs assert-stopped
)

git -C "$REPOSITORY_ROOT" worktree remove "$WORKTREE_PATH"

echo "Worktree removed: $WORKTREE_PATH"
echo "The local branch was retained."
if [[ "$CURRENT_WORKTREE" == "$WORKTREE_PATH" ]]; then
  echo "Return to the main checkout with: cd $REPOSITORY_ROOT"
fi
