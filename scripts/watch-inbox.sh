#!/usr/bin/env bash
# A long-running local watcher for the reel ingest pass. The loop, the interval
# and the warning that belongs with it all live in scripts/watch-inbox.ts; this
# file is the rails and the TypeScript.
#
# FIVE SECONDS AGAINST AN UNDOCUMENTED INSTAGRAM ENDPOINT IS AGGRESSIVE and will
# eventually trip rate limiting or a challenge on the account whose cookies this
# uses. The circuit breaker in lib/ingest/inbox/instagram-poll.ts stops the
# watcher when that happens and is neither weakened nor bypassed here. Read the
# header of the .ts before leaving this running. Do not leave this running.
#
# Run from anywhere:  ./scripts/watch-inbox.sh [--interval=5s] [--once]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# ── The rail (scripts/verify-reel-ingest.sh's, same reasoning) ────────────────
# This writes users' reels and saved places, on a loop, unattended, from a
# developer's laptop. A run against a shared database would do that to real
# people's rows with a local .env.local's credentials — so the check comes before
# anything else happens. Parsed in four steps rather than one regex because each
# step is a case that got it wrong: the scheme's "//" reads as a path, and a
# password may contain an "@" (hence "##", the LAST one). Anything unparseable
# falls through to a host that matches nothing and is refused.
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

This is a development watcher. It polls Instagram on a loop and writes reels and
saved places for whichever accounts it finds — not something to point at a shared
database. Point DATABASE_URL at the local Supabase (port 54322) and run it again.
MSG
    exit 1 ;;
esac

if ! psql "$DB" -q -c 'select 1' >/dev/null 2>&1; then
  echo "no database on $DB_HOST — start the local Supabase first (npx supabase start)." >&2
  exit 1
fi

# ── Credentials ──────────────────────────────────────────────────────────────
# .env.local is not committed and is where the Instagram cookies, the Gemini key
# and the Naver keys live. Sourced rather than parsed, as
# scripts/verify-reel-thumbnail.sh does, so quoted values survive; `set -a`
# exports what it defines. The watcher needs the whole set — the inbox cookies,
# the model key for both rungs of the extraction ladder, and the geocoder — so
# picking one variable out by grep the way verify-reel-asr.sh does would mean
# five greps and a stale list.
if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi
export DATABASE_URL="$DB"

# NOT CHECKED HERE, ON PURPOSE. IG_SESSION_ID and friends are verified by
# `readCredentials` in lib/ingest/inbox/instagram-poll.ts, which throws a named
# InboxNotConfiguredError, and the watcher prints one clear line saying which
# variable is missing and what to do about it. A second list of variable names in
# this file would be a second list to forget to update.

# ── Getting TypeScript to run ────────────────────────────────────────────────
# Same harness as scripts/verify-reel-asr.sh: Node 20 has no
# --experimental-strip-types, so the entry point is compiled with the typescript
# already installed and run as plain CommonJS, into a temp directory so a run
# leaves the working tree exactly as it found it.
#
# node_modules is symlinked in rather than compiling inside the repo, because the
# pass loads `pg`, `@google/genai` and the Supabase client at require time and a
# temp dir outside the repo cannot resolve them.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ln -s "$ROOT/node_modules" "$OUT/node_modules"

(cd "$ROOT" && npx --no-install tsc scripts/watch-inbox.ts \
  --outDir "$OUT" --rootDir "$ROOT" \
  --module commonjs --moduleResolution node --target es2022 \
  --lib es2022,dom \
  --esModuleInterop --strict --skipLibCheck --types node)

[ -f "$OUT/scripts/watch-inbox.js" ] || { echo "tsc emitted nothing" >&2; exit 1; }

# `exec` so Ctrl-C reaches node directly: the watcher installs its own SIGINT
# handler to finish the pass in flight rather than leaving a reel claimed and
# stuck on `pending`, and a bash wrapper in the middle would swallow the signal.
exec node "$OUT/scripts/watch-inbox.js" "$@"
