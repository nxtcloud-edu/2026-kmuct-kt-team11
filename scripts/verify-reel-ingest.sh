#!/usr/bin/env bash
# Proof that the reel ingestion write path does what lib/ingest/* claims: one
# transaction, idempotent on redelivery, nothing saved for a sender we do not
# know, and saved_places that die with their reel.
#
# Unlike scripts/seed-accounts.sh this talks to no dev server. The write path is
# library code, not a route — there is no HTTP endpoint to exercise yet — so the
# assertions call saveReel() and resolveSenderToUser() directly and read the rows
# back in SQL. scripts/verify-reel-ingest.ts is where they live.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# ── The rail (scripts/seed-accounts.sh's, same reasoning) ─────────────────────
# This creates a user by igsid and deletes users by igsid. Both are local-fixture
# operations, and an igsid is app-scoped: the values below are meaningless in any
# other environment, which makes a run against a shared database pure damage with
# no test value. Parsed in four steps rather than one regex because each step is a
# case that got it wrong — the scheme's "//" reads as a path, and a password may
# contain an "@" (hence "##", the LAST one). Anything unparseable falls through to
# a host that matches nothing and is refused.
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

This script inserts and deletes users, reels and saved places to assert on them.
Point DATABASE_URL at the local Supabase (port 54322) and run it again.
MSG
    exit 1 ;;
esac

if ! psql "$DB" -q -c 'select 1' >/dev/null 2>&1; then
  echo "no database on $DB_HOST — start the local Supabase first (npx supabase start)." >&2
  exit 1
fi

# ── Getting TypeScript to run ────────────────────────────────────────────────
# This repo is on Node 20, which has no --experimental-strip-types, and tsx is not
# a dependency — five runtime dependencies is a deliberate number. So the entry
# point is compiled with the typescript that is already installed and run as plain
# CommonJS. Output goes to a temp directory rather than the repo so a run leaves
# the working tree exactly as it found it; NODE_PATH is what lets `require('pg')`
# resolve from out there.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

TSC_LOG="$OUT/tsc.log"
set +e
(cd "$ROOT" && npx --no-install tsc scripts/verify-reel-ingest.ts \
  --outDir "$OUT" --rootDir "$ROOT" \
  --module commonjs --moduleResolution node --target es2022 \
  --esModuleInterop --strict --skipLibCheck) >"$TSC_LOG" 2>&1
set -e

# lib/extract/types.ts is owned by another workstream and may not be on disk yet.
# `CaptionExtraction` is imported as a TYPE, so it is erased before any of this
# runs and its absence cannot change behaviour — but tsc still reports the missing
# module. That one diagnostic is tolerated; every other error is fatal, which is
# the part that matters: this must not become a blanket "ignore tsc".
if grep -E 'error TS' "$TSC_LOG" | grep -qv 'extract/types'; then
  echo "typescript errors that are not the pending lib/extract/types.ts:" >&2
  grep -E 'error TS' "$TSC_LOG" | grep -v 'extract/types' >&2
  exit 1
fi
if grep -q 'extract/types' "$TSC_LOG"; then
  echo "note: lib/extract/types.ts is not on disk yet; it is a type-only import and is erased at runtime."
fi
[ -f "$OUT/scripts/verify-reel-ingest.js" ] || { echo "tsc emitted nothing:" >&2; cat "$TSC_LOG" >&2; exit 1; }

DATABASE_URL="$DB" NODE_PATH="$ROOT/node_modules" node "$OUT/scripts/verify-reel-ingest.js"
