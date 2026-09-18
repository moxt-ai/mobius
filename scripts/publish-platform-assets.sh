#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  staging)
    bucket="mobius-platform-staging-web-assets"
    app_origin="https://mobius.moxt.ws"
    asset_origin="https://assets.mobius.moxt.ws"
    ;;
  production)
    bucket="mobius-platform-production-web-assets"
    app_origin="https://mobius.moxt.ai"
    asset_origin="https://assets.mobius.moxt.ai"
    ;;
  *)
    echo "Expected staging or production" >&2
    exit 1
    ;;
esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
asset_directory="$repository_root/packages/platform-app/dist/assets"
if [[ ! -d "$asset_directory" ]]; then
  echo "Missing built Platform assets: $asset_directory" >&2
  exit 1
fi

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find "$asset_directory" -type f ! -name '*.map' -print0)
if [[ "${#assets[@]}" -eq 0 ]]; then
  echo "No Platform assets were built" >&2
  exit 1
fi

manifest_directory="$(mktemp -d)"
headers="$(mktemp)"
trap 'rm -rf "$manifest_directory"; rm -f "$headers"' EXIT
javascript_manifest="$manifest_directory/javascript.json"
css_manifest="$manifest_directory/css.json"
printf '[]\n' > "$javascript_manifest"
printf '[]\n' > "$css_manifest"

javascript_entries=()
css_entries=()
for file in "${assets[@]}"; do
  key="${file#"$repository_root/packages/platform-app/dist/"}"
  if [[ ! "$key" =~ ^assets/[A-Za-z0-9._-]+\.(css|js)$ ]]; then
    echo "Unsafe or unsupported Platform asset path: $key" >&2
    exit 1
  fi
  entry="{\"key\":\"$key\",\"file\":\"$file\"}"
  case "$file" in
    *.css)
      css_entries+=("$entry")
      ;;
    *.js)
      javascript_entries+=("$entry")
      ;;
  esac
done

write_manifest() {
  local manifest="$1"
  shift
  printf '%s\n' "$(IFS=,; printf '[%s]' "$*")" > "$manifest"
}
write_manifest "$javascript_manifest" "${javascript_entries[@]}"
write_manifest "$css_manifest" "${css_entries[@]}"

if ! pnpm wrangler r2 bucket info "$bucket" --json >/dev/null; then
  echo "Platform asset bucket is unavailable: $bucket" >&2
  echo "Provision it and its CDN domain and CORS policy as documented in docs/platform-hosting.md." >&2
  exit 1
fi

publish_assets() {
  local manifest="$1"
  local content_type="$2"
  local count="$3"
  if [[ "$count" -eq 0 ]]; then
    return
  fi
  # The pinned bulk command reuses one authenticated Wrangler process while
  # separate manifests preserve the content type for JavaScript and CSS.
  pnpm wrangler r2 bulk put "$bucket" \
    --filename "$manifest" \
    --content-type "$content_type" \
    --cache-control "public, max-age=31536000, immutable" \
    --concurrency 20 \
    --remote \
    --force
}
publish_assets "$javascript_manifest" "text/javascript; charset=utf-8" "${#javascript_entries[@]}"
publish_assets "$css_manifest" "text/css; charset=utf-8" "${#css_entries[@]}"

probe_key="${assets[0]#"$repository_root/packages/platform-app/dist/"}"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --header "Origin: $app_origin" \
  --dump-header "$headers" \
  --output /dev/null \
  "$asset_origin/$probe_key"
if ! grep -Fqi "access-control-allow-origin: $app_origin" "$headers"; then
  echo "Platform asset CDN did not authorize $app_origin" >&2
  exit 1
fi
if ! grep -Fqi 'cache-control: public, max-age=31536000, immutable' "$headers"; then
  echo "Platform asset CDN did not preserve immutable caching" >&2
  exit 1
fi
