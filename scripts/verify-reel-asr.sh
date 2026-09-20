#!/usr/bin/env bash
# Proof that the ASR rung and the ladder work against the live Gemini API.
# The assertions live in scripts/verify-reel-asr.ts.
#
# THIS SPENDS REAL, BILLED GEMINI CALLS — three, or four with --with-files-api.
# It opens no database connection and writes nothing anywhere.
#
# NO INSTAGRAM MEDIA IS USED. The clips are synthesised by ffmpeg into a temp
# directory and deleted at the end; a real reel is third-party copyrighted video
# and must never enter this repository (spec H7).
#
# Run from the repo root: ./scripts/verify-reel-asr.sh [--with-files-api]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── The rails ────────────────────────────────────────────────────────────────
# Same reasoning as scripts/verify-geocode.sh: this script writes nothing to
# Postgres, so a localhost DATABASE_URL check would be copied ceremony guarding
# nothing. What it DOES spend is billed model quota, so the rail that applies is
# the credential and the tools — refuse clearly up front rather than emit a
# confusing failure four steps in.
command -v ffmpeg >/dev/null 2>&1 || {
  echo "refusing to run: ffmpeg is not on PATH. It synthesises the test clip; no reel is downloaded." >&2
  exit 1
}

if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$ROOT/.env.local" ]; then
  # Only the variable being looked for, and only its value — not a blanket
  # `source`, which would run whatever else is in a file full of secrets.
  value="$(grep -E '^GEMINI_API_KEY=' "$ROOT/.env.local" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  [ -n "$value" ] && export GEMINI_API_KEY="$value"
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  cat >&2 <<'MSG'
refusing to run: GEMINI_API_KEY is not set and is not in .env.local.

It is server-side only and must never be prefixed NEXT_PUBLIC_.
Get one at https://aistudio.google.com/apikey, put it in .env.local, run again.
MSG
  exit 1
fi

# ── Getting TypeScript to run ────────────────────────────────────────────────
# Node 20 has no --experimental-strip-types and tsx is not a dependency, so the
# entry point is compiled with the typescript already installed and run as plain
# CommonJS, into a temp directory so a run leaves the working tree untouched.
#
# node_modules is symlinked in rather than compiling inside the repo: the ASR
# rung requires @google/genai at load time, and a temp dir outside the repo
# cannot resolve it.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ln -s "$ROOT/node_modules" "$OUT/node_modules"

(cd "$ROOT" && npx --no-install tsc scripts/verify-reel-asr.ts \
  --outDir "$OUT" --rootDir "$ROOT" \
  --module commonjs --moduleResolution node --target es2022 \
  --lib es2022,dom \
  --esModuleInterop --strict --skipLibCheck --types node)

[ -f "$OUT/scripts/verify-reel-asr.js" ] || { echo "tsc emitted nothing" >&2; exit 1; }

node "$OUT/scripts/verify-reel-asr.js" "$@"
