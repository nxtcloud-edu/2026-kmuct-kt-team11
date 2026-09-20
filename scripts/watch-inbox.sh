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

# THE CALLER'S value, captured BEFORE any env file is sourced, because the files
# below set DATABASE_URL too and we need to know which one the human chose.
# Resolution order, highest first: the environment this was invoked with,
# .env.remote (only under --remote), .env.local, then the local default.
#
# This used to read `DB="${DATABASE_URL:-<local default>}"` here and then
# `export DATABASE_URL="$DB"` AFTER sourcing, which silently undid whatever the
# files had set. A --remote run therefore polled production Instagram while
# reading the LOCAL database's ingest_state — and refused to start, quoting a
# breaker that had tripped on the laptop hours earlier and had nothing to do
# with the account it was about to poll.
CALLER_DB="${DATABASE_URL:-}"

# Parsed HERE, before the env files are sourced, because the sourcing itself
# branches on it. It used to live with the rail below, which is where it is
# used second — and after the sourcing moved above the rail, that left it read
# before it was set (`set -u` caught it).
ALLOW_REMOTE=0
for arg in "$@"; do
  case "$arg" in --remote) ALLOW_REMOTE=1 ;; esac
done

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

# ── Remote overrides ─────────────────────────────────────────────────────────
# A --remote run has to be remote in EVERY service it touches, not just the one
# named on the command line. Pointing DATABASE_URL at production while .env.local
# still said SUPABASE_URL=127.0.0.1 wrote thumbnail OBJECTS to a laptop and
# thumbnail PATHS to production, so every card rendered a broken image: the row
# said a picture existed and the bucket it named had never heard of it.
#
# Sourced AFTER .env.local so it wins, and only under --remote so an ordinary
# local run cannot accidentally reach production storage. Gitignored by .env*.
if [ "$ALLOW_REMOTE" = 1 ] && [ -f "$ROOT/.env.remote" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.remote"
  set +a
  echo "sourced .env.remote — storage and database both point at production" >&2
fi

# Now, and only now, is DATABASE_URL final.
DB="${CALLER_DB:-${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}}"

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
# `--remote` is the deliberate way past this, and it exists because the reason
# the rail was written stopped being the only consideration. Instagram challenged
# the account twice in one afternoon and both challenges landed on requests made
# from a Vercel function, while the same cookie kept answering from a home
# connection. So running this pass from a laptop against the PRODUCTION database
# is no longer a mistake to prevent — it is the mitigation, and the cloud is the
# thing being switched off (`INGEST_OPPORTUNISTIC=off`).
#
# It stays opt-in and noisy because everything the original rail said is still
# true: this writes real users' reels and saved places, on a loop, unattended,
# with whatever credentials .env.local happens to hold. Typing the flag is the
# point — nobody reaches production by forgetting to set a variable.

case "$DB_HOST" in
  localhost|127.0.0.1|::1) ;;
  *)
    if [ "$ALLOW_REMOTE" != 1 ]; then
      cat >&2 <<MSG
refusing to run: DATABASE_URL points at "$DB_HOST", which is not localhost.

This watcher polls Instagram on a loop and writes reels and saved places for
whichever accounts it finds. Against a shared database that is real people's
rows, written unattended with this machine's credentials.

If that is what you mean — running the poll from a home connection because the
cloud IP keeps getting challenged — say so explicitly:

    ./scripts/watch-inbox.sh --remote --interval=60s

Otherwise point DATABASE_URL at the local Supabase (port 54322).
MSG
      exit 1
    fi
    cat >&2 <<MSG
── WRITING TO A REMOTE DATABASE: $DB_HOST ──
Real accounts' reels and saved places will be created by this loop.
Ctrl-C stops it after the pass in flight finishes.
MSG
    ;;
esac

# The query string is stripped for THIS probe only. A remote URL carries driver
# options psql has never heard of — `uselibpqcompat`, which node-postgres needs
# to accept Supabase's pooler certificate — and psql exits non-zero on an unknown
# parameter, which read as "no database" and sent the user to start a local one
# that was not the problem. The probe only needs to answer "can this host be
# reached and authenticated"; the driver keeps the full URL.
PROBE_DB="${DB%%\?*}"
if ! psql "$PROBE_DB" -q -c 'select 1' >/dev/null 2>&1; then
  if [ "$ALLOW_REMOTE" = 1 ]; then
    echo "cannot reach $DB_HOST — check DATABASE_URL and the network." >&2
  else
    echo "no database on $DB_HOST — start the local Supabase first (npx supabase start)." >&2
  fi
  exit 1
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
# `--remote` is consumed here; the TypeScript entry point does not know it and
# would reject it as an unknown flag.
ARGS=()
for arg in "$@"; do
  case "$arg" in --remote) ;; *) ARGS+=("$arg") ;; esac
done

exec node "$OUT/scripts/watch-inbox.js" "${ARGS[@]+"${ARGS[@]}"}"
