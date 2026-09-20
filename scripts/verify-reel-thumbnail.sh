#!/usr/bin/env bash
# Proof that a reel's cover frame survives the whole journey: downloaded from a
# host we do not control, verified from its own bytes, uploaded to Supabase
# Storage, read back byte-identical, served anonymously at its public URL, and
# recorded on the `reels` row with the dimensions the FILE reports rather than
# the ones the payload claimed.
#
# It makes real network requests — one to fetch an image, several to the local
# Supabase Storage API. It writes and deletes one fixture user, one reel and one
# object, and cleans all three up. scripts/verify-reel-thumbnail.ts holds the
# assertions.
#
#   ./scripts/verify-reel-thumbnail.sh
#   REEL_THUMB_URL='https://scontent….cdninstagram.com/…?oe=…' ./scripts/verify-reel-thumbnail.sh
#
# The second form is the one that exercises the genuine Instagram host. Those
# URLs expire in about four and a half days, which is exactly why none is
# committed here and why this pipeline copies the bytes at all.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# ── The rail (scripts/verify-reel-ingest.sh's, same reasoning) ────────────────
# This creates a user by igsid, writes a reel, uploads an object and deletes all
# of it. Those are local-fixture operations; against a shared project they are
# pure damage with no test value. Parsed in four steps rather than one regex
# because each step is a case that got it wrong — the scheme's "//" reads as a
# path, and a password may contain an "@" (hence "##", the LAST one).
hostport="${DB#*://}"       # strip scheme
hostport="${hostport##*@}"  # strip credentials
hostport="${hostport%%/*}"  # strip /database
hostport="${hostport%%\?*}" # strip ?sslmode=…
case "$hostport" in
  \[*\]*) DB_HOST="${hostport#\[}"; DB_HOST="${DB_HOST%%\]*}" ;;  # [::1]:54322
  *)      DB_HOST="${hostport%%:*}" ;;
esac
case "$DB_HOST" in
  localhost|127.0.0.1|::1) ;;
  *)
    cat >&2 <<MSG
refusing to run: DATABASE_URL points at "$DB_HOST", which is not localhost.

This script inserts and deletes users, reels and storage objects to assert on
them. Point DATABASE_URL at the local Supabase (port 54322) and run it again.
MSG
    exit 1 ;;
esac

if ! psql "$DB" -q -c 'select 1' >/dev/null 2>&1; then
  echo "no database on $DB_HOST — start the local Supabase first (npx supabase start)." >&2
  exit 1
fi

# ── Env, loaded the same way the app does ────────────────────────────────────
# .env.local is not committed and is where the local anon/service keys live.
# Sourced rather than parsed so quoted values survive; `set -a` exports.
if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

# The service role key is the one credential this script cannot do without: the
# anon key can read the public path but not write to the bucket. Named, never
# echoed.
: "${SUPABASE_URL:?SUPABASE_URL is not set. \`npx supabase start\` prints it; put it in .env.local.}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is not set. \`npx supabase status\` prints it; put it in .env.local.}"

# The same localhost rail, applied to Storage. An accidental hosted SUPABASE_URL
# would upload fixture objects into a real bucket.
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *)
    echo "refusing to run: SUPABASE_URL is \"$SUPABASE_URL\", which is not local." >&2
    echo "This uploads and deletes objects. Point it at the local Supabase and run it again." >&2
    exit 1 ;;
esac

# Storage must actually be up. `[storage] enabled = true` in supabase/config.toml
# only takes effect after a restart, and the failure without one is a 503 from
# every upload — which reads like a bucket problem and is not.
if ! curl -fsS -o /dev/null "$SUPABASE_URL/storage/v1/bucket" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" 2>/dev/null; then
  cat >&2 <<MSG
the Storage API at $SUPABASE_URL/storage/v1 is not answering.

supabase/config.toml has [storage] enabled = true, but that is read at start.
Restart the local stack and run this again:
  npx supabase stop && npx supabase start
MSG
  exit 1
fi

# ── Getting TypeScript to run (scripts/verify-reel-ingest.sh's approach) ─────
# Node 20, no --experimental-strip-types, and tsx is not a dependency. The entry
# point is compiled with the typescript that is already installed and run as
# plain CommonJS. Output goes to a temp directory so a run leaves the working
# tree exactly as it found it; NODE_PATH is what lets `require('pg')` and
# `require('@supabase/supabase-js')` resolve from out there.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

TSC_LOG="$OUT/tsc.log"
set +e
(cd "$ROOT" && npx --no-install tsc scripts/verify-reel-thumbnail.ts \
  --outDir "$OUT" --rootDir "$ROOT" \
  --module commonjs --moduleResolution node --target es2022 \
  --esModuleInterop --strict --skipLibCheck) >"$TSC_LOG" 2>&1
set -e

if grep -qE 'error TS' "$TSC_LOG"; then
  echo "typescript errors:" >&2
  grep -E 'error TS' "$TSC_LOG" >&2
  exit 1
fi
[ -f "$OUT/scripts/verify-reel-thumbnail.js" ] || { echo "tsc emitted nothing:" >&2; cat "$TSC_LOG" >&2; exit 1; }

DATABASE_URL="$DB" NODE_PATH="$ROOT/node_modules" \
  node "$OUT/scripts/verify-reel-thumbnail.js"
