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

# Randomised: a fixed address trips the 5/hour per-email rate limit once the suite
# has been run a few times, which fails the test for the wrong reason.
r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' -d "{\"email\":\"nobody-$N@example.com\",\"intent\":\"sign_in\"}")
ck "unknown email also 202 (no enumeration oracle)" 202 "$(code "$r")"

TOKEN=$(grep -a -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//')
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
T2=$(grep -a -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//')
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

echo "── onboarding profile ─────────────────────────────────────────────────"
r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' \
      -d '{"gender":"female","age_band":"20s","mbti":"INFJ","home_area":"성수"}')
ck "PATCH /me accepts the onboarding fields" 200 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['mbti']")" = "INFJ" ] && echo ok || echo 'mbti not returned')"

r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' -d '{"mbti":"XXXX"}')
ck "an invalid MBTI is 422" 422 "$(code "$r")"

r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' -d '{"age_band":"99s"}')
ck "an invalid age_band is 422" 422 "$(code "$r")"

echo "── password auth ──────────────────────────────────────────────────────"
PJAR=$(mktemp); PHDR=$(mktemp)
# $RANDOM alone has 32768 values and `users` is never emptied between runs, so a
# collision turns an expected 201 into a 409 and the case fails for the wrong
# reason. $$ plus the clock makes every address below unique per run.
RUN="$$-$(date +%s)-$RANDOM"
PEMAIL="pw-$RUN@example.com"
# The one answer all three indistinguishability cases must give, spelled out so an
# empty jget (a changed response shape) fails instead of matching another empty.
INVALID="https://gaja.app/errors/invalid-credentials"
pwx() { # pwx <cookie-jar> <json-body> [extra curl args…]
  local j=$1 b=$2; shift 2
  curl -s -b "$j" -c "$j" -w '\n%{http_code}' -X POST "$BASE/api/auth/password" \
    -H 'content-type: application/json' -d "$b" "$@"
}
pw() { pwx "$PJAR" "$1"; }
mlink() { # mlink <email> — request a magic link, echo the token the dev log printed.
  curl -s -o /dev/null -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"intent\":\"sign_in\"}"
  # -a is load-bearing: the dev log carries NUL bytes and plain grep prints nothing.
  grep -a -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//'
}

r=$(pw "{\"email\":\"$PEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}")
ck "sign-up with a password creates an account" 201 "$(code "$r")"

r=$(pw "{\"email\":\"$PEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}")
ck "signing up twice is 409, not a takeover" 409 "$(code "$r")"

r=$(pw "{\"email\":\"$PEMAIL\",\"password\":\"short\",\"intent\":\"sign_in\"}")
ck "a password under 8 chars is 422" 422 "$(code "$r")"

r=$(pw "{\"email\":\"$PEMAIL\",\"password\":\"wrong-password\",\"intent\":\"sign_in\"}")
ck "a wrong password is 401" 401 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['type']")" = "$INVALID" ] && echo ok || echo 'wrong problem type')"

# The enumeration check: an address that does not exist must answer exactly as a
# wrong password does. A different status or problem type here is the oracle.
# Both halves are asserted against the literal answer, not against each other —
# jget swallows errors to "", and "" == "" is a case that tests nothing.
r2=$(pw "{\"email\":\"nosuch-$RUN@example.com\",\"password\":\"wrong-password\",\"intent\":\"sign_in\"}")
ck "an unknown address is indistinguishable from a wrong password" 401 "$(code "$r2")" \
   "$([ "$(body "$r2" | jget "['type']")" = "$INVALID" ] && echo ok || echo 'wrong problem type')"

# The magic-link account from earlier has no password at all; it must also be
# indistinguishable rather than admitting it has none.
r3=$(pw "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\",\"intent\":\"sign_in\"}")
ck "a passwordless account is indistinguishable too" 401 "$(code "$r3")" \
   "$([ "$(body "$r3" | jget "['type']")" = "$INVALID" ] && echo ok || echo 'wrong problem type')"

r=$(pw "{\"email\":\"$PEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_in\"}")
ck "the right password signs in" 200 "$(code "$r")"
ck "  and the session works" 200 \
   "$(curl -s -o /dev/null -w '%{http_code}' -b "$PJAR" "$BASE/api/me")"

# Sign-up spends from the same per-address budget as sign-in, so probing an
# address costs what guessing a password costs: repeating a sign-up against an
# address we already know must stop answering 409 and start answering 429.
# The budget is per address, so this burst uses one of its own and leaves the
# cases above and below untouched.
TEMAIL="pw-throttle-$RUN@example.com"
r=$(pwx /dev/null "{\"email\":\"$TEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}")
ck "throttle fixture signs up" 201 "$(code "$r")"
tries=0
while [ "$tries" -lt 12 ]; do
  r=$(pwx /dev/null "{\"email\":\"$TEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}" -D "$PHDR")
  [ "$(code "$r")" = "429" ] && break
  tries=$((tries+1))
done
ck "repeating a sign-up on a known address is throttled, not 409 forever" 429 "$(code "$r")"
ck "  and the 429 carries Retry-After" "ok" \
   "$(grep -qai '^retry-after:' "$PHDR" && echo ok || echo missing)"

# A proven identity wipes the address's failure budget: five failures, one success,
# five more failures is ten failures against a MAX_FAILURES of 8 in a 15-minute
# window, so a 429 anywhere in the second burst means the success did not reset it.
CEMAIL="pw-reset-$RUN@example.com"
r=$(pwx /dev/null "{\"email\":\"$CEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}")
ck "reset fixture signs up" 201 "$(code "$r")"
for _ in 1 2 3 4 5; do
  r=$(pwx /dev/null "{\"email\":\"$CEMAIL\",\"password\":\"wrong-password\",\"intent\":\"sign_in\"}")
done
ck "  five failures stay under the limit" 401 "$(code "$r")"
r=$(pwx /dev/null "{\"email\":\"$CEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_in\"}")
ck "  then the right password still signs in" 200 "$(code "$r")"
tripped=""
for _ in 1 2 3 4 5; do
  r=$(pwx /dev/null "{\"email\":\"$CEMAIL\",\"password\":\"wrong-password\",\"intent\":\"sign_in\"}")
  [ "$(code "$r")" = "429" ] && tripped=yes
done
ck "a successful sign-in clears the failure count" 401 "$(code "$r")" \
   "$([ -z "$tripped" ] && echo ok || echo 'the limit tripped mid-burst')"

# The defect that prompted this suite: anyone can set a password on an address
# they do not own. Proving ownership of it by magic link must clear that password,
# or the squatter keeps a way in behind the real owner.
# Ordering: this case and the one after it each read the newest token out of the
# dev log, so each must follow its own magic-link request immediately. They are
# independent of each other, but neither survives an interleaved magic link.
SQEMAIL="pw-squat-$RUN@example.com"
r=$(pwx /dev/null "{\"email\":\"$SQEMAIL\",\"password\":\"squatter-pass\",\"intent\":\"sign_up\"}")
ck "a squatter can set a password on an address they do not own" 201 "$(code "$r")"
SQTOKEN=$(mlink "$SQEMAIL")
r=$(curl -s -b /dev/null -c /dev/null -w '\n%{http_code}' -X POST "$BASE/api/auth/session" \
     -H 'content-type: application/json' -d "{\"token\":\"$SQTOKEN\"}")
ck "  the real owner's magic link signs them in" 200 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['outcome']")" = "signed_in" ] && echo ok || echo 'wrong outcome')"
r=$(pwx /dev/null "{\"email\":\"$SQEMAIL\",\"password\":\"squatter-pass\",\"intent\":\"sign_in\"}")
ck "  and verifying the address kills the squatted password" 401 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['type']")" = "$INVALID" ] && echo ok || echo 'wrong problem type')"

# A password sign-up leaves email_verified_at NULL. That unverified row must still
# be the row the magic link matches — otherwise the squatter's account shadows the
# address forever and the owner's link is a dead end rather than a takeover.
UVEMAIL="pw-unverified-$RUN@example.com"
r=$(pwx /dev/null "{\"email\":\"$UVEMAIL\",\"password\":\"correct-horse\",\"intent\":\"sign_up\"}")
ck "sign-up leaves the address unverified" 201 "$(code "$r")"
UVTOKEN=$(mlink "$UVEMAIL")
r=$(curl -s -b /dev/null -c /dev/null -w '\n%{http_code}' -X POST "$BASE/api/auth/session" \
     -H 'content-type: application/json' -d "{\"token\":\"$UVTOKEN\"}")
ck "an unverified address is still matchable by magic link" 200 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['outcome']")" = "signed_in" ] && echo ok || echo 'wrong outcome')"

echo "── sign out ────────────────────────────────────────────────────────────"
r=$(req -X DELETE "$BASE/api/auth/session"); ck "DELETE /auth/session is 204" 204 "$(code "$r")"
r=$(req "$BASE/api/me"); ck "session is revoked server-side" 401 "$(code "$r")"

rm -f "$JAR" "$OTHER" "$PJAR" "$PHDR"
echo
printf '  \033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
exit $(( fail > 0 ))
