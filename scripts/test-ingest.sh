#!/usr/bin/env bash
# Unit tests for the Instagram inbox parser.
#
# Node 20 cannot execute TypeScript, and this project has no test runner and no
# intention of growing one for three files — so the two modules under test are
# compiled on their own into a temp dir and run under `node --test`. Only
# lib/ingest/inbox/parse.ts and its test are compiled, which is also what keeps
# the parser honest: it imports nothing with a side effect, so a stray runtime
# import breaks this script rather than quietly coupling the parser to Postgres.
#
# NO LIVE INSTAGRAM REQUEST IS MADE. The fixture is synthetic.
#
# Run from the repo root: ./scripts/test-ingest.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

npx tsc lib/ingest/inbox/parse.ts lib/ingest/inbox/parse.test.ts \
  --outDir "$OUT" --rootDir . \
  --module commonjs --moduleResolution node --target es2022 \
  --strict --esModuleInterop --skipLibCheck --types node

# Run from the repo root so the test resolves the fixture off process.cwd().
node --test "$OUT/lib/ingest/inbox/"
