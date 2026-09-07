#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: pnpm db:environment <inventory.json> <staging|production> <--local|--remote>" >&2
  exit 64
fi
case "$2" in staging|production) ;; *) echo "Invalid environment" >&2; exit 64 ;; esac
case "$3" in --local|--remote) ;; *) echo "Select --local or --remote explicitly" >&2; exit 64 ;; esac
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
shards="$(timeout 10s jq -er --arg environment "$2" '
  .[$environment] |
  if type == "array" and length > 0 then .[].id
  else error("Deployment environment must have at least one shard") end
' "$1")"
while IFS= read -r shard; do
  bash "$script_directory/migrate-shard.sh" "$1" "$2" "$shard" "$3"
done <<< "$shards"
