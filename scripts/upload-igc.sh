#!/usr/bin/env bash
#
# Bulk-upload every .igc file in a directory to the Open IGC Database.
#
# Each file is one `POST /flights` request (the API ingests one file per request).
# Dedup is by content hash, so re-running is safe and cheap: already-stored files
# just return 200. Uses `find` (not a shell glob) so it handles huge directories.
#
# Usage: scripts/upload-igc.sh -d DIR [-u BASE_URL] [-j JOBS] [--named]

set -uo pipefail

DIR=""
URL_BASE="https://igc.baptiste.app"
JOBS=8
ANON=1

usage() {
  cat <<'EOF'
Usage: upload-igc.sh -d DIR [-u BASE_URL] [-j JOBS] [--named]

  -d, --dir DIR     Directory containing .igc files (required)
  -u, --url BASE    Base URL of the app (default: https://igc.baptiste.app)
                    e.g. http://localhost:5174 for local dev
  -j, --jobs N      Number of parallel uploads (default: 8)
      --named       Keep pilot names (default strips them: ?anonymous=1)
  -h, --help        Show this help

Prints "<http_code>  <file>" per upload, then a summary tally.
  201 = added   200 = duplicate   400 = rejected   5xx = server error
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir)  DIR="$2"; shift 2 ;;
    -u|--url)  URL_BASE="$2"; shift 2 ;;
    -j|--jobs) JOBS="$2"; shift 2 ;;
    --named)   ANON=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$DIR" ] || { echo "error: -d DIR is required" >&2; usage; exit 2; }
[ -d "$DIR" ] || { echo "error: not a directory: $DIR" >&2; exit 2; }

URL="${URL_BASE%/}/flights"
[ "$ANON" = 1 ] && URL="$URL?anonymous=1"

count=$(find "$DIR" -maxdepth 1 -type f -name '*.igc' | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || { echo "no .igc files in $DIR" >&2; exit 1; }
echo "Uploading $count file(s) to $URL with $JOBS parallel job(s)..." >&2

results=$(mktemp)
trap 'rm -f "$results"' EXIT

# One curl per file. `-w %{http_code}` reports the status; curl itself only fails on
# network errors (not on HTTP 4xx/5xx), so a rejected file still prints its code.
# `--retry` transparently retries transient failures (429, 500, 502, 503, 504 and
# connection errors) with exponential backoff, so a momentarily overloaded server
# recovers instead of dropping the file. Only the final status is printed.
find "$DIR" -maxdepth 1 -type f -name '*.igc' -print0 \
  | xargs -0 -P "$JOBS" -I {} sh -c '
      code=$(curl -s -o /dev/null -w "%{http_code}" \
        --retry 5 --retry-delay 2 --retry-max-time 120 --retry-connrefused \
        --data-binary @"$1" \
        -H "Content-Type: application/octet-stream" \
        "$0")
      echo "$code  $1"
    ' "$URL" {} \
  | tee "$results"

echo "" >&2
echo "Summary (count  http_code):" >&2
awk '{print $1}' "$results" | sort | uniq -c | sort -rn >&2
