#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm run worktree:new -- [--json] [name]

Create or reuse .worktrees/<name> on branch worktree/<name>, based on the
latest origin/main, then prepare it for development. When name is omitted, a
short random name is generated.
EOF
}

error() {
  echo "Worktree creation failed: $1" >&2
}

random_name() {
  local words=(amber birch brook cedar coral ember flint frost glade haven lunar maple ocean orbit raven ridge slate solar spark storm swift topaz trace vivid)
  local first_index=$((RANDOM % ${#words[@]}))
  local second_index=$((RANDOM % ${#words[@]}))
  printf '%s-%s\n' "${words[$first_index]}" "${words[$second_index]}"
}

find_registered_worktree_for_branch() {
  local candidate=""
  local line
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        candidate=${line#worktree }
        ;;
      "branch refs/heads/$BRANCH")
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  done < <(git -C "$REPOSITORY_ROOT" worktree list --porcelain)
}

acquire_lock() {
  local deadline=$((SECONDS + 30))
  while ! mkdir "$LOCK_DIRECTORY" 2>/dev/null; do
    if [[ -f "$LOCK_DIRECTORY/pid" ]]; then
      local owner_pid
      owner_pid=$(sed -n '1p' "$LOCK_DIRECTORY/pid" 2>/dev/null || true)
      if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -rf "$LOCK_DIRECTORY"
        continue
      fi
    fi
    if [[ $SECONDS -ge $deadline ]]; then
      error "timed out waiting for $LOCK_DIRECTORY"
      return 1
    fi
    sleep 0.1
  done
  printf '%s\n' "$$" > "$LOCK_DIRECTORY/pid"
}

release_lock() {
  if [[ -n "${LOCK_DIRECTORY:-}" && -d "$LOCK_DIRECTORY" ]]; then
    rm -rf "$LOCK_DIRECTORY"
  fi
}

render_json() {
  node -e 'process.stdout.write(JSON.stringify({branch: process.argv[1], path: process.argv[2], reused: process.argv[3] === "true"}) + "\n")' "$BRANCH" "$WORKTREE_DIRECTORY" "$REUSED"
}

JSON_OUTPUT=false
WORKTREE_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUTPUT=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      ;;
    -*)
      error "unsupported argument: $1"
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$WORKTREE_NAME" ]]; then
        error "only one worktree name can be specified"
        exit 2
      fi
      WORKTREE_NAME=$1
      ;;
  esac
  shift
done

if [[ -z "$WORKTREE_NAME" ]]; then
  WORKTREE_NAME=$(random_name)
fi
if [[ ! "$WORKTREE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  error "the name may contain only letters, numbers, dots, underscores, and hyphens"
  exit 2
fi

GIT_COMMON_DIRECTORY=$(git rev-parse --path-format=absolute --git-common-dir)
REPOSITORY_ROOT=$(dirname "$GIT_COMMON_DIRECTORY")
BRANCH="worktree/$WORKTREE_NAME"
WORKTREE_DIRECTORY="$REPOSITORY_ROOT/.worktrees/$WORKTREE_NAME"
LOCK_DIRECTORY="$GIT_COMMON_DIRECTORY/mobius-worktree-$WORKTREE_NAME.lock"

if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
  error "the generated branch name is invalid: $BRANCH"
  exit 2
fi

if [[ "$JSON_OUTPUT" == "true" ]]; then
  exec 3>&1
  exec 1>&2
fi

acquire_lock
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Fetching origin/main..."
git -C "$REPOSITORY_ROOT" fetch origin main
mkdir -p "$REPOSITORY_ROOT/.worktrees"

REGISTERED_WORKTREE=$(find_registered_worktree_for_branch)
REUSED=false
if [[ -n "$REGISTERED_WORKTREE" ]]; then
  if [[ "$REGISTERED_WORKTREE" != "$WORKTREE_DIRECTORY" ]]; then
    error "$BRANCH is already checked out at $REGISTERED_WORKTREE"
    exit 1
  fi
  REUSED=true
elif [[ -e "$WORKTREE_DIRECTORY" ]]; then
  error "$WORKTREE_DIRECTORY exists but is not a registered Git worktree"
  exit 1
elif git -C "$REPOSITORY_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$REPOSITORY_ROOT" worktree add "$WORKTREE_DIRECTORY" "$BRANCH"
else
  git -C "$REPOSITORY_ROOT" worktree add -b "$BRANCH" "$WORKTREE_DIRECTORY" origin/main
fi

(
  cd "$WORKTREE_DIRECTORY"
  bash scripts/worktree/setup.sh
)

release_lock
trap - EXIT INT TERM

if [[ "$JSON_OUTPUT" == "true" ]]; then
  render_json >&3
else
  echo ""
  echo "Mobius worktree is ready:"
  echo "  branch: $BRANCH"
  echo "  path:   $WORKTREE_DIRECTORY"
  echo ""
  echo "Next: cd $WORKTREE_DIRECTORY"
  echo "MOBIUS_WORKTREE_RESULT=$(render_json)"
fi
