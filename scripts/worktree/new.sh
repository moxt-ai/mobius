#!/usr/bin/env bash
set -euo pipefail

# Switch to the repository root
cd "$(git rev-parse --show-toplevel)"

error() { echo -e "ERROR: $1" >&2; }
success() { echo "OK: $1"; }

random_word() {
  local words
  words=(amber azure birch blaze brook cedar cliff coral crane creek drift ember field flint frost glade grove haven hazel heath heron ivory larch lemon linen lotus lunar maple marsh mocha noble ocean orbit otter peach pearl petal pixel plain prism raven ridge river rocky slate smoke solar spark spire storm swift talon thorn tiger toast topaz trace trail tulip valor vapor vault viola vivid waltz whirl zebra)

  echo "${words[$((RANDOM % ${#words[@]}))]}"
}

acquire_worktree_lock() {
  local deadline=$((SECONDS + 900))
  while ! mkdir "$WORKTREE_LOCK_DIR" 2>/dev/null; do
    if [ -f "$WORKTREE_LOCK_DIR/pid" ]; then
      local owner_pid
      owner_pid=$(sed -n '1p' "$WORKTREE_LOCK_DIR/pid" 2>/dev/null || true)
      if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -rf "$WORKTREE_LOCK_DIR"
        continue
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      error "Timed out waiting for the worktree init lock: $WORKTREE_LOCK_DIR"
      return 1
    fi
    sleep 1
  done
  printf '%s\n%s\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$WORKTREE_LOCK_DIR/pid"
}

release_worktree_lock() {
  rm -rf "$WORKTREE_LOCK_DIR"
}

find_registered_worktree_for_branch() {
  git -C "$REPO_ROOT" worktree list --porcelain |
    awk -v branch="refs/heads/$BRANCH" '
      $1 == "worktree" { path = $2 }
      $1 == "branch" && $2 == branch { print path }
    '
}

emit_result() {
  local reused="$1"
  if [ "$JSON_OUTPUT" = "true" ]; then
    jq -nc \
      --arg branch "$BRANCH" \
      --arg path "$WORKTREE_DIR" \
      --argjson reused "$reused" \
      '{branch: $branch, path: $path, reused: $reused}'
    return
  fi

  echo ""
  echo "==============================================================================="
  echo "  Worktree is ready. cd to the following directory to start working:"
  echo "     $WORKTREE_DIR"
  echo "==============================================================================="
  echo ""
  echo "MOBIUS_WORKTREE_RESULT=$(jq -nc --arg branch "$BRANCH" --arg path "$WORKTREE_DIR" --argjson reused "$reused" '{branch: $branch, path: $path, reused: $reused}')"
}

JSON_OUTPUT=false
WORKTREE_NAME=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      JSON_OUTPUT=true
      ;;
    --)
      shift
      if [ "$#" -gt 0 ]; then
        WORKTREE_NAME="$1"
      fi
      ;;
    -*)
      error "Unsupported option: $1"
      exit 2
      ;;
    *)
      if [ -n "$WORKTREE_NAME" ]; then
        error "Only one worktree name can be specified"
        exit 2
      fi
      WORKTREE_NAME="$1"
      ;;
  esac
  shift
done

if [ -z "$WORKTREE_NAME" ]; then
  WORKTREE_NAME="$(random_word)-$(random_word)"
fi
if [[ ! "$WORKTREE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  error "Worktree name may only contain letters, digits, dot, underscore and hyphen"
  exit 2
fi

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)
REPO_ROOT=$(dirname "$GIT_COMMON_DIR")
GITHUB_ID=$(gh api user --jq .login)
BRANCH="${GITHUB_ID}/${WORKTREE_NAME}"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/${GITHUB_ID}-${WORKTREE_NAME}"
WORKTREE_LOCK_DIR="${GIT_COMMON_DIR}/mobius-worktree-init-${GITHUB_ID}-${WORKTREE_NAME}.lock"

if [ "$JSON_OUTPUT" = "true" ]; then
  exec 3>&1
  exec 1>&2
fi

acquire_worktree_lock
trap release_worktree_lock EXIT INT TERM

echo "Preparing worktree: $BRANCH"
git -C "$REPO_ROOT" fetch origin main

REGISTERED_WORKTREE=$(find_registered_worktree_for_branch)
REUSED=false
if [ -n "$REGISTERED_WORKTREE" ]; then
  if [ "$REGISTERED_WORKTREE" != "$WORKTREE_DIR" ]; then
    error "Branch $BRANCH is already bound to another worktree: $REGISTERED_WORKTREE"
    exit 1
  fi
  REUSED=true
elif [ -e "$WORKTREE_DIR" ]; then
  error "Target directory exists but is not a registered worktree: $WORKTREE_DIR"
  exit 1
elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH"
else
  git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" origin/main
fi

(
  cd "$WORKTREE_DIR"
  scripts/worktree/setup.sh
)

release_worktree_lock
trap - EXIT INT TERM

if [ "$JSON_OUTPUT" = "true" ]; then
  emit_result "$REUSED" >&3
else
  emit_result "$REUSED"
fi
