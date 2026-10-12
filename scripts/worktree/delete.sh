#!/usr/bin/env bash
set -euo pipefail

error() { echo -e "ERROR: $1" >&2; }

random_word() {
  local words
  words=(amber azure birch blaze brook cedar cliff coral crane creek drift ember field flint frost glade grove haven hazel heath heron ivory larch lemon linen lotus lunar maple marsh mocha noble ocean orbit otter peach pearl petal pixel plain prism raven ridge river rocky slate smoke solar spark spire storm swift talon thorn tiger toast topaz trace trail tulip valor vapor vault viola vivid waltz whirl zebra)

  echo "${words[$((RANDOM % ${#words[@]}))]}"
}

find_registered_worktree_directory() {
  local requested_directory_name="$1"
  local expected_path="$REPO_ROOT/.worktrees/$requested_directory_name"
  local record
  local candidate_path

  while IFS= read -r record; do
    case "$record" in
      "worktree "*)
        candidate_path="${record#worktree }"
        if [ "$candidate_path" = "$expected_path" ]; then
          if [ ! -d "$expected_path" ]; then
            error "Registered worktree directory does not exist: .worktrees/$requested_directory_name"
            return 1
          fi
          printf '%s\n' "$candidate_path"
          return 0
        fi
        ;;
    esac
  done < <(git -C "$REPO_ROOT" worktree list --porcelain)

  error "Registered worktree directory not found: .worktrees/$requested_directory_name"
  return 1
}

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)
REPO_ROOT=$(dirname "$GIT_COMMON_DIR")
CURRENT_WORKTREE_PATH=$(git rev-parse --show-toplevel)
DELETE_FROM_MAIN=false

if [ "$#" -gt 1 ]; then
  error "Only one worktree directory name can be specified"
  exit 2
fi

if [ "$#" -eq 1 ]; then
  if [ "$CURRENT_WORKTREE_PATH" != "$REPO_ROOT" ]; then
    error "Worktrees can only be deleted by directory name from the main repository; inside a worktree run scripts/worktree/delete.sh without arguments"
    exit 2
  fi
  if [[ ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    error "Worktree directory name may only contain letters, digits, dot, underscore and hyphen"
    exit 2
  fi
  if ! WORKTREE_PATH=$(find_registered_worktree_directory "$1"); then
    exit 1
  fi
  DELETE_FROM_MAIN=true
else
  WORKTREE_PATH="$CURRENT_WORKTREE_PATH"
fi

if [ "$WORKTREE_PATH" = "$REPO_ROOT" ]; then
  error "Cannot delete the main repository; pass a worktree directory name under .worktrees/ instead"
  exit 1
fi

# Snapshot random worktree names before removal so they can be reported.
DELETED_WORKTREE_NAME=""
if [ "$DELETE_FROM_MAIN" != "true" ]; then
  DELETED_WORKTREE_NAME=$(basename "$WORKTREE_PATH")
fi

(
  cd "$WORKTREE_PATH"
  scripts/worktree/teardown.sh
)

git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_PATH"

echo ""
echo "==============================================================================="
if [ "$DELETE_FROM_MAIN" = "true" ]; then
  echo "  Worktree deleted. The current directory is still the main repository:"
  echo "     $REPO_ROOT"
else
  echo "  Worktree deleted. Close this terminal, or switch back to the main repository:"
  echo "     cd $REPO_ROOT"
fi
echo "  Local Git branches are preserved."
echo "==============================================================================="
echo ""
