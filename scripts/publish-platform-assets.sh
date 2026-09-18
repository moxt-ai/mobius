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

asset_directory="packages/platform-app/dist/assets"
if [[ ! -d "$asset_directory" ]]; then
  echo "Missing built Platform assets: $asset_directory" >&2
  exit 1
fi

export bucket
upload_asset() {
  local file="$1"
  local content_type
  case "$file" in
    *.css)
      content_type="text/css; charset=utf-8"
      ;;
    *.js)
      content_type="text/javascript; charset=utf-8"
      ;;
    *)
      echo "Unsupported Platform asset type: $file" >&2
      return 1
      ;;
  esac
  local key="${file#packages/platform-app/dist/}"
  if [[ ! "$key" =~ ^assets/[A-Za-z0-9._-]+\.(css|js)$ ]]; then
    echo "Unsafe Platform asset path: $key" >&2
    return 1
  fi
  pnpm wrangler r2 object put "$bucket/$key" \
    --file "$file" \
    --content-type "$content_type" \
    --cache-control "public, max-age=31536000, immutable" \
    --remote \
    --force >/dev/null
}
export -f upload_asset

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find "$asset_directory" -type f ! -name '*.map' -print0)
if [[ "${#assets[@]}" -eq 0 ]]; then
  echo "No Platform assets were built" >&2
  exit 1
fi
printf '%s\0' "${assets[@]}" | xargs -0 -n 1 -P 12 bash -c 'upload_asset "$1"' _

probe_key="${assets[0]#packages/platform-app/dist/}"
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
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
