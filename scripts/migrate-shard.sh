#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: pnpm db:shard <inventory.json> <staging|production> <shard-id> <--local|--remote>" >&2
  exit 64
fi
case "$2" in staging|production) ;; *) echo "Invalid environment" >&2; exit 64 ;; esac
case "$4" in --local|--remote) ;; *) echo "Select --local or --remote explicitly" >&2; exit 64 ;; esac
if [[ "$1" != *.json || ! "$3" =~ ^(apac|wnam)-[0-9]{2}$ ]]; then
  echo "Invalid inventory path or shard ID" >&2
  exit 64
fi
readonly inventory_path="$(realpath -- "$1")"
if [[ ! -f "$inventory_path" || "$inventory_path" != *.json ]]; then
  echo "Inventory must resolve to a JSON file" >&2
  exit 64
fi
readonly package_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../packages/relay-cloudflare" && pwd -P)"
readonly migration_config_dir="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf -- "$migration_config_dir"
  echo "mobius shard migration exited with status $status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Resolve exactly one authorized database from the Cloud-owned inventory.
timeout 10s jq -e \
  --arg environment "$2" \
  --arg shard "$3" \
  --arg migrations "$package_path/migrations/d1" '
  if type != "object" or .account_id != "95af7a3d67be8c49b1619544e3ce53c0" then
    error("Invalid Cloud account")
  else . end |
  .account_id as $account |
  .[$environment] |
  if type != "array" then error("Invalid shard inventory") else . end |
  if all(.[];
    type == "object" and
    (.id | type == "string" and test("^(apac|wnam)-[0-9]{2}$")) and
    (.database_id | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
    .database_name == ("mobius-cloud-" + $environment + "-" + .id)
  ) then . else error("Invalid shard target") end |
  if (map(.id) | unique | length) != length or
     (map(.database_id) | unique | length) != length then
    error("Duplicate shard target")
  else . end |
  map(select(.id == $shard)) |
  if length != 1 then error("Shard not found") else .[0] end |
  {
    name: "mobius-shard-migrations",
    account_id: $account,
    compatibility_date: "2026-09-04",
    d1_databases: [{
      binding: "DIRECTORY_DATABASE",
      database_name: .database_name,
      database_id: .database_id,
      migrations_dir: $migrations,
      migrations_table: "mobius_migrations"
    }]
  }
' "$inventory_path" > "$migration_config_dir/wrangler.json"

timeout 10s jq -r '.d1_databases[0] | "mobius migration target: \(.database_name) (\(.database_id))"' "$migration_config_dir/wrangler.json"
local_options=()
if [[ "$4" == --local ]]; then
  local_options=(--persist-to "$package_path/.wrangler/shards")
fi
cd -- "$package_path"
timeout --foreground 120s pnpm exec wrangler d1 migrations apply DIRECTORY_DATABASE \
  --config "$migration_config_dir/wrangler.json" \
  "$4" "${local_options[@]}"
