#!/usr/bin/env bash
#
# DESTRUCTIVE: empties the Open IGC Database — deletes every R2 .igc object and
# every row in the D1 `flights` table. Defaults to LOCAL; pass --remote to wipe
# production. Always asks for confirmation unless --yes is given.
#
# R2 has no bulk delete, so objects are removed one per call, keyed off the D1
# rows (object key = "<id>.igc"). This preserves the bucket's public-access / custom
# domain config (unlike delete-and-recreate), but is O(number of files) — slow for
# very large buckets. R2 objects with no matching D1 row (orphans) are NOT removed.
#
# Usage: scripts/empty-db.sh [--remote] [--yes] [-j JOBS]

set -uo pipefail
cd "$(dirname "$0")/.."

DB="open-igc-db"        # D1 database_name (wrangler.toml)
BUCKET="open-igc"       # R2 bucket_name   (wrangler.toml)
SCOPE="--local"
SCOPE_LABEL="LOCAL"
ASSUME_YES=0
JOBS=8

usage() {
  cat <<'EOF'
Usage: empty-db.sh [--remote] [--yes] [-j JOBS]

      --remote     Wipe the PRODUCTION database and bucket (default: local)
      --yes        Skip the confirmation prompt (dangerous)
  -j, --jobs N     Parallel R2 deletes (default: 8)
  -h, --help       Show this help

Deletes every R2 .igc object then every row in the D1 flights table.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)  SCOPE="--remote"; SCOPE_LABEL="REMOTE (production)"; shift ;;
    --yes)     ASSUME_YES=1; shift ;;
    -j|--jobs) JOBS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

# Prefer the repo-local wrangler binary (no npx spawn overhead per object).
WRANGLER="./node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

# Run a D1 query and echo ONLY the clean JSON on stdout. wrangler can print a banner /
# telemetry notice / update warning before the JSON (especially on the first --remote
# call), so we drop everything before the leading '[' and verify the result parses —
# otherwise a failed query would masquerade as "0 rows". Aborts loudly on failure.
d1_json() {
  local sql="$1" out
  out=$($WRANGLER d1 execute "$DB" $SCOPE --json --command "$sql") || {
    echo "error: 'wrangler d1 execute' failed for: $sql" >&2
    return 1
  }
  out=$(printf '%s\n' "$out" | sed -n '/^[[:space:]]*\[/,$p')
  if ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    echo "error: could not parse D1 output as JSON. Raw output:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

echo "Target: $SCOPE_LABEL — D1 '$DB' + R2 '$BUCKET'"

# Collect the object keys to delete from the D1 rows.
ids=$(d1_json "SELECT id FROM flights" | jq -r '.[0].results[].id') || {
  echo "Aborting: could not read flight ids from D1 (nothing was deleted)." >&2
  exit 1
}
count=$(printf '%s\n' "$ids" | grep -c . || true)

echo "Found $count flight(s) to delete."
if [ "$count" -eq 0 ]; then
  echo "Nothing to do."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  echo "This will PERMANENTLY delete $count R2 object(s) and all D1 rows from $SCOPE_LABEL."
  printf "Type 'DELETE' to proceed: "
  read -r reply
  [ "$reply" = "DELETE" ] || { echo "Aborted."; exit 1; }
fi

echo "Deleting $count R2 object(s) with $JOBS parallel job(s)..."
# Missing objects (already gone) are ignored so the script is safe to re-run.
printf '%s\n' "$ids" | grep . \
  | xargs -P "$JOBS" -I {} sh -c '
      '"$WRANGLER"' r2 object delete "'"$BUCKET"'/{}.igc" '"$SCOPE"' -y >/dev/null 2>&1 \
        || echo "  warn: could not delete {}.igc" >&2
    '

echo "Clearing D1 table 'flights'..."
$WRANGLER d1 execute "$DB" $SCOPE --command "DELETE FROM flights;" >/dev/null

remaining=$(d1_json "SELECT COUNT(*) AS n FROM flights" | jq -r '.[0].results[0].n' 2>/dev/null)
echo "Done. Rows remaining in D1: ${remaining:-unknown}"
