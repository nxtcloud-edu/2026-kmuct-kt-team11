#!/usr/bin/env bash
# Slice 1 smoke test. Exercises the rules that the OpenAPI mock could not:
# object-level authorization, idempotency replay, the D3 CHECK constraint,
# write-boundary dedupe, and the duplicate-save partial index.
#
# Requires: dev server on :3000, `supabase start` running.
set -uo pipefail
BASE="${BASE:-http://localhost:3000}"
JAR=$(mktemp); LOG="${DEV_LOG:-/tmp/gaja-dev.log}"
# Each run uses fresh coordinates: fixed ones make the second run collide with the
# dedupe rule this suite is testing.
N=$RANDOM
# Each run uses fresh coordinates: fixed ones make the second run collide with the
# dedupe rule this suite is testing.
J1=$(python3 -c "import random;print(f'{37.50 + random.random()*0.09:.5f}')")
J2=$(python3 -c "import random;print(f'{127.00 + random.random()*0.09:.5f}')")
J1B=$(python3 -c "print(f'{$J1 + 0.00015:.5f}')")   # ~17 m north — inside the dedupe radius
J1C=$(python3 -c "print(f'{$J1 + 0.02:.5f}')")      # ~2.2 km — well outside it
J1D=$(python3 -c "print(f'{$J1 + 0.04:.5f}')")
pass=0; fail=0

ck() { # ck <label> <expected-status> <actual-status> [extra-check-result]
  if [ "$2" = "$3" ] && [ "${4:-ok}" = "ok" ]; then
    printf '  \033[32m✓\033[0m %-52s %s\n' "$1" "$3"; pass=$((pass+1))
  else
    printf '  \033[31m✗\033[0m %-52s got %s want %s %s\n' "$1" "$3" "$2" "${4:-}"; fail=$((fail+1))
  fi
}
code() { tail -1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
req()  { curl -s -b "$JAR" -c "$JAR" -w '\n%{http_code}' "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

echo "── auth ───────────────────────────────────────────────────────────────"
r=$(curl -s -w '\n%{http_code}' "$BASE/api/me")
ck "GET /me without a session is 401" 401 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['type']")" = "https://gaja.app/errors/unauthenticated" ] && echo ok || echo 'wrong problem type')"

EMAIL="smoke-$RANDOM@example.com"
r=$(req -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"intent\":\"sign_in\"}")
ck "POST /auth/magic-link is 202" 202 "$(code "$r")"

r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' -d '{"email":"nobody-at-all@example.com","intent":"sign_in"}')
ck "unknown email also 202 (no enumeration oracle)" 202 "$(code "$r")"

TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//')
r=$(req -X POST "$BASE/api/auth/session" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
ck "POST /auth/session signs in a brand-new account" 200 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['outcome']")" = "signed_in" ] && echo ok || echo 'wrong outcome')"
ck "  recovery_channels is [email] (no igsid)" "['email']" "$(body "$r" | jget "['user']['recovery_channels']")"

r=$(req -X POST "$BASE/api/auth/session" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
ck "token is single-use — reuse is 400" 400 "$(code "$r")"

r=$(req "$BASE/api/me"); ck "GET /me with a session is 200" 200 "$(code "$r")"

echo "── places: dedupe at the write boundary (spec 5.1) ─────────────────────"
r=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' \
  -d "{\"name\":\"어니언 성수 $N\",\"category\":\"cafe\",\"lat\":$J1,\"lng\":$J2,\"area\":\"성수\"}")
ck "POST /places creates" 201 "$(code "$r")"
PID=$(body "$r" | jget "['id']")

r=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' \
  -d "{\"name\":\"어니언 성수 $N 점\",\"category\":\"cafe\",\"lat\":$J1B,\"lng\":$J2,\"area\":\"성수\"}")
ck "near-duplicate returns 200 not 201" 200 "$(code "$r")"
ck "  and resolves to the SAME place id" "$PID" "$(body "$r" | jget "['id']")"

r=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' \
  -d "{\"name\":\"대림창고 $N\",\"category\":\"cafe\",\"lat\":$J1C,\"lng\":$J2,\"area\":\"성수\"}")
ck "a genuinely different place still creates" 201 "$(code "$r")"
PID2=$(body "$r" | jget "['id']")

r=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' -d '{"name":"x","category":"cafe","lat":999,"lng":0,"area":"a"}')
ck "out-of-range lat is 422" 422 "$(code "$r")"

echo "── saved places ────────────────────────────────────────────────────────"
r=$(req -X POST "$BASE/api/saved-places" -H 'content-type: application/json' -d "{\"place_id\":\"$PID\",\"hook\":\"티라미수가 미쳤다\"}")
ck "POST /saved-places creates" 201 "$(code "$r")"
SPID=$(body "$r" | jget "['id']")
ck "  born 'resolved' (no extractor in slice 1)" "resolved" "$(body "$r" | jget "['status']")"

r=$(req -X POST "$BASE/api/saved-places" -H 'content-type: application/json' -d "{\"place_id\":\"$PID\"}")
ck "saving the same place twice is 409" 409 "$(code "$r")"

r=$(req -X POST "$BASE/api/saved-places" -H 'content-type: application/json' -d "{\"place_id\":\"$PID2\"}")
ck "a different place still saves" 201 "$(code "$r")"

r=$(req "$BASE/api/saved-places?limit=1")
ck "list is paginated" 200 "$(code "$r")"
ck "  has_more true at limit=1" "True" "$(body "$r" | jget "['has_more']")"
CUR=$(body "$r" | jget "['next_cursor']")
r=$(req "$BASE/api/saved-places?limit=1&cursor=$CUR")
ck "  cursor returns the next page" 200 "$(code "$r")"

r=$(req "$BASE/api/saved-places?cursor=not-a-real-cursor")
ck "a malformed cursor is 422, not a 500" 422 "$(code "$r")"

echo "── idempotency (api-contract 4) ────────────────────────────────────────"
K=$(uuidgen)
B="{\"name\":\"성수연방 $N\",\"category\":\"shop\",\"lat\":$J1D,\"lng\":$J2,\"area\":\"성수\"}"
r1=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' -H "Idempotency-Key: $K" -d "$B")
ck "first call with a key" 201 "$(code "$r1")"
r2=$(curl -s -b "$JAR" -D /tmp/idem.hdr -w '\n%{http_code}' -X POST "$BASE/api/places" -H 'content-type: application/json' -H "Idempotency-Key: $K" -d "$B")
ck "same key + same body replays" 201 "$(code "$r2")"
ck "  bodies identical" "$(body "$r1" | jget "['id']")" "$(body "$r2" | jget "['id']")"
ck "  Idempotency-Replayed header present" "ok" "$(grep -qi 'idempotency-replayed' /tmp/idem.hdr && echo ok || echo missing)"
r=$(req -X POST "$BASE/api/places" -H 'content-type: application/json' -H "Idempotency-Key: $K" -d '{"name":"other","category":"shop","lat":37.5,"lng":127.0,"area":"성수"}')
ck "same key + different body is 409" 409 "$(code "$r")"

echo "── groups and invites ──────────────────────────────────────────────────"
r=$(req -X POST "$BASE/api/groups" -H 'content-type: application/json' -d '{"name":"민지 & 준호"}')
ck "POST /groups creates, caller is owner" 201 "$(code "$r")"
GID=$(body "$r" | jget "['id']")
ck "  creator role is owner" "owner" "$(body "$r" | jget "['role']")"

r=$(req -X POST "$BASE/api/groups/$GID/invites")
ck "POST /groups/:id/invites creates" 201 "$(code "$r")"
INV=$(body "$r" | jget "['token']")

r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/invites/$INV/accept")
ck "accept without a session asks for a recovery channel" 200 "$(code "$r")"
ck "  requires=recovery_channel" "recovery_channel" "$(body "$r" | jget "['requires']")"
ck "  leaks only the group name" "ok" "$(body "$r" | jget "['group']" | grep -q 'created_by\|members' && echo leaked || echo ok)"

r=$(req -X POST "$BASE/api/invites/$INV/accept")
ck "accept as an existing member is 409" 409 "$(code "$r")"

echo "── object-level authorization (OWASP API1) ─────────────────────────────"
OTHER=$(mktemp)
curl -s -c "$OTHER" -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' -d "{\"email\":\"other-$RANDOM@example.com\",\"intent\":\"sign_in\"}" >/dev/null
T2=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//')
curl -s -b "$OTHER" -c "$OTHER" -X POST "$BASE/api/auth/session" -H 'content-type: application/json' -d "{\"token\":\"$T2\"}" >/dev/null

r=$(curl -s -b "$OTHER" -w '\n%{http_code}' "$BASE/api/saved-places/$SPID")
ck "another user cannot read my personal saved place" 404 "$(code "$r")"
r=$(curl -s -b "$OTHER" -X DELETE -w '\n%{http_code}' "$BASE/api/saved-places/$SPID")
ck "another user cannot delete it" 404 "$(code "$r")"
r=$(curl -s -b "$OTHER" -w '\n%{http_code}' "$BASE/api/groups/$GID")
ck "another user cannot read my group" 403 "$(code "$r")"
r=$(curl -s -b "$OTHER" -w '\n%{http_code}' "$BASE/api/saved-places?group_id=$GID")
ck "another user cannot list my group's saved places" 403 "$(code "$r")"

echo "── D3: recovery channel is a rule, not a convention ────────────────────"
r=$(req -X DELETE "$BASE/api/me/email")
ck "removing the only recovery channel is 409" 409 "$(code "$r")"
ck "  with the documented problem type" "https://gaja.app/errors/recovery-channel-required" "$(body "$r" | jget "['type']")"

echo "── sign out ────────────────────────────────────────────────────────────"
r=$(req -X DELETE "$BASE/api/auth/session"); ck "DELETE /auth/session is 204" 204 "$(code "$r")"
r=$(req "$BASE/api/me"); ck "session is revoked server-side" 401 "$(code "$r")"

rm -f "$JAR" "$OTHER"
echo
printf '  \033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
exit $(( fail > 0 ))
