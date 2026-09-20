#!/usr/bin/env bash
# Proof that lib/research/geocode.ts turns the addresses in a real reel caption
# into real Seoul coordinates — and, specifically, that x/y are not read the wrong
# way round. Naver returns x=longitude, y=latitude; swap them and every venue
# lands in the Yellow Sea at coordinates that pass every CHECK constraint we have.
# The assertions live in scripts/verify-geocode.ts.
#
# Run from the repo root: ./scripts/verify-geocode.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── The rail, and why it is not the one in verify-reel-ingest.sh ──────────────
# That script refuses to run unless DATABASE_URL points at localhost, because it
# inserts and deletes users to assert on them. This one opens no database
# connection and writes nothing anywhere, so a localhost check here would be
# copied ceremony guarding nothing. What this script DOES spend is billed NCP
# quota against a real key, so the rail that applies is the credential itself:
# refuse clearly when it is absent rather than emit five confusing 401s.
for name in NEXT_PUBLIC_NAVER_MAP_CLIENT_ID NAVER_MAP_CLIENT_SECRET; do
  if [ -z "${!name:-}" ] && [ -f "$ROOT/.env.local" ]; then
    # Only the variable being looked for, and only its value — not a blanket
    # `source`, which would run whatever else is in a file full of secrets.
    value="$(grep -E "^${name}=" "$ROOT/.env.local" | tail -n 1 | cut -d= -f2- || true)"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [ -n "$value" ] && export "$name=$value"
  fi
  if [ -z "${!name:-}" ]; then
    cat >&2 <<MSG
refusing to run: $name is not set and is not in .env.local.

Both the NCP client id and the client secret are needed — the geocoding endpoint
authenticates with the pair. Set them and run this again.
MSG
    exit 1
  fi
done

# ── Getting TypeScript to run ────────────────────────────────────────────────
# Same reasoning as scripts/verify-reel-ingest.sh: Node 20 has no
# --experimental-strip-types and tsx is not a dependency, so the entry point is
# compiled with the typescript already installed and run as plain CommonJS.
# Output goes to a temp directory so a run leaves the working tree untouched.
#
# Only geocode.ts and this entry point are compiled — no pg, no lib/db. That is
# also a check on the adapter: it must import nothing with a side effect, so a
# stray import that drags in Postgres breaks this script loudly rather than
# quietly coupling the geocoder to the database.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

(cd "$ROOT" && npx --no-install tsc scripts/verify-geocode.ts \
  --outDir "$OUT" --rootDir "$ROOT" \
  --module commonjs --moduleResolution node --target es2022 \
  --lib es2022,dom \
  --esModuleInterop --strict --skipLibCheck --types node)

[ -f "$OUT/scripts/verify-geocode.js" ] || { echo "tsc emitted nothing" >&2; exit 1; }

node "$OUT/scripts/verify-geocode.js"
