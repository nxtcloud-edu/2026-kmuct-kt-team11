#!/usr/bin/env bash
# The two demo accounts: one with onboarding still ahead of it, one with a home
# screen already full. Between them they cover the only two first impressions
# the app has.
#
# Goes through the real API the way scripts/seed-prototype.sh does — so a run
# also proves sign-up, PATCH /me and the two place routes still work — and then
# backdates saved_at in SQL, which the API deliberately offers no way to set.
#
# Sign-up is by password, not magic link. The link is printed to the dev log and
# has to be grepped back out of it, which is fine for a test suite and wrong for
# a demo: whoever runs this should be able to read two addresses off the end of
# the output and log straight in.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# The credentials, spelled out here because they are also spelled out in the
# README. A known password is the feature — these are local fixtures, and the
# rail below is what keeps them local.
NEW_EMAIL="${NEW_EMAIL:-demo-new@example.com}"
HOME_EMAIL="${HOME_EMAIL:-demo-home@example.com}"
PASSWORD="${DEMO_PASSWORD:-gaja-demo-1234}"   # 14 chars; the route's floor is 8

# ── The rail ──────────────────────────────────────────────────────────────────
# This mints accounts whose password is published and deletes rows by address.
# Both are local-fixture operations. Someone will eventually run this with a
# production env loaded, and that must stop here rather than three lines later
# with a known-password account on a live database — so the check comes before
# anything else happens, the delete included.
# Parsed in four steps rather than one regex, because each step is a case that
# got it wrong: the scheme carries a "//" that a naive "%%/*" reads as the path,
# and a password may contain an "@" (hence "##", the LAST one, not the first).
# Anything that is not a URL at all — the libpq keyword form, a bare database
# name — falls through to a host that matches nothing and is refused, which is
# the direction an unparseable value should fail in.
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

This script creates accounts whose password is published in the README, and it
deletes users by address before recreating them. Neither belongs on a shared or
production database. Point DATABASE_URL at the local Supabase (port 54322) and
run it again.
MSG
    exit 1 ;;
esac
# Same reasoning for the other end: the accounts are actually minted by HTTP, so
# a localhost DATABASE_URL with a remote BASE would still publish a password to
# somebody else's deployment.
case "$BASE" in
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
  *)
    echo "refusing to run: BASE is \"$BASE\", not localhost — see the rail above." >&2
    exit 1 ;;
esac

# ── Helpers (scripts/smoke.sh's) ──────────────────────────────────────────────
code() { tail -1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
want() { # want <expected-status> <response> <what-failed>
  [ "$(code "$2")" = "$1" ] && return 0
  echo "  ✗ $3: got $(code "$2"), wanted $1" >&2
  body "$2" >&2
  exit 1
}

# A 401 from /api/me is a healthy answer here — the only thing being asked is
# whether anything is listening.
if ! curl -s -o /dev/null --max-time 5 "$BASE/api/me"; then
  echo "no dev server on $BASE — start it first (npx next dev)." >&2
  exit 1
fi

NEW_JAR=$(mktemp); HOME_JAR=$(mktemp)
trap 'rm -f "$NEW_JAR" "$HOME_JAR"' EXIT

# ── Re-runnability: delete, then recreate ─────────────────────────────────────
# Fixed addresses rather than a per-run suffix, because a demo account you can
# bookmark is worth more than one you have to re-read off the terminal. The cost
# is this delete, and its scope is the whole of the safety argument: two literal
# addresses, nothing pattern-matched, nothing joined. Everything downstream of a
# user — sessions, saved places, reels — goes with the row by ON DELETE CASCADE.
# login_attempts is keyed on the address rather than the user, so it survives the
# cascade and has to be named; without it a ninth run inside fifteen minutes is
# throttled rather than seeded.
psql "$DB" -q -c "delete from users          where email in ('$NEW_EMAIL','$HOME_EMAIL');"
psql "$DB" -q -c "delete from login_attempts where email in ('$NEW_EMAIL','$HOME_EMAIL');"

signup() { # signup <cookie-jar> <email>
  local jar=$1 email=$2 r
  r=$(curl -s -b "$jar" -c "$jar" -w '\n%{http_code}' -X POST "$BASE/api/auth/password" \
        -H 'content-type: application/json' \
        -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"intent\":\"sign_up\"}")
  want 201 "$r" "sign-up for $email"
}

# ── A — the new user ──────────────────────────────────────────────────────────
# Signs up and stops. onboarded_at stays null, so app/(app)/layout.tsx bounces
# this account to /onboarding and it lands on step 1 with nothing pre-filled.
# Nothing else may be done to this account; every line added here is a step the
# first-run demo no longer shows.
signup "$NEW_JAR" "$NEW_EMAIL"
echo "A  $NEW_EMAIL — signed up, not onboarded"

# ── B — the established user ──────────────────────────────────────────────────
signup "$HOME_JAR" "$HOME_EMAIL"
r=$(curl -s -b "$HOME_JAR" -c "$HOME_JAR" -w '\n%{http_code}' -X PATCH "$BASE/api/me" \
      -H 'content-type: application/json' \
      -d '{"display_name":"민지","gender":"female","age_band":"20s","mbti":"INFJ","home_area":"성수","onboarded":true}')
want 200 "$r" "PATCH /me for $HOME_EMAIL"
echo "B  $HOME_EMAIL — 민지 · 20s · INFJ · 활동 지역 성수"

# The venues are scripts/seed-prototype.sh's, deliberately: they are real Seoul
# places with hooks of the shape the extractor is meant to produce, and a second
# invented set would be a second thing to keep honest.
#
# `save` is the column that makes the home screen work. listPlacesNearby()
# excludes places the caller has already saved — a "near you" section listing
# what you have got is not a recommendation — so if B saved every 성수 fixture
# the 성수 근처 map would come back empty. The three no rows exist to be pins.
#
# name | category | lat | lng | area | hook | days-ago | save
while IFS='|' read -r name cat lat lng area hook ago save; do
  [ -z "${name:-}" ] && continue
  pid=$(curl -s -b "$HOME_JAR" -X POST "$BASE/api/places" -H 'content-type: application/json' \
    -d "{\"name\":\"$name\",\"category\":\"$cat\",\"lat\":$lat,\"lng\":$lng,\"area\":\"$area\"}" \
    | jget "['id']" || echo '')
  [ -z "$pid" ] && { echo "  skip $name (place not created)"; continue; }

  if [ "$save" != "yes" ]; then
    printf '  · %-24s %-4s nearby only\n' "$name" "$area"
    continue
  fi

  hookjson=$([ -n "$hook" ] && echo "\"$hook\"" || echo null)
  sid=$(curl -s -b "$HOME_JAR" -X POST "$BASE/api/saved-places" -H 'content-type: application/json' \
    -d "{\"place_id\":\"$pid\",\"hook\":$hookjson}" | jget "['id']" || echo '')
  [ -z "$sid" ] && { echo "  skip $name (not saved)"; continue; }

  # The API has no way to set saved_at, and a deck where every card was saved in
  # the same second is not a populated home screen, it is a fixture.
  psql "$DB" -q -c \
    "update saved_places set saved_at = now() - interval '$ago days' - (random()*interval '8 hours') where id = '$sid';"
  printf '  + %-24s %-4s %sd ago\n' "$name" "$area" "$ago"
done <<'ROWS'
어니언 성수|cafe|37.5445|127.0557|성수|티라미수가 미쳤다|0|yes
자그마치|cafe|37.5447|127.0553|성수|웨이팅 없는 오전이 답|1|yes
디뮤지엄|exhibition|37.5385|127.0489|성수|전시 끝나기 전에 꼭|3|yes
블루보틀 한남|cafe|37.5348|127.0011|한남|조용하고 자리 넓음|5|yes
리움미술관|exhibition|37.5385|126.9990|한남|예약 필수, 주말은 오픈런|5|yes
오라운지 한남동 루프탑 바|restaurant|37.5340|127.0025|한남|노을 시간 맞춰서 가야 의미 있음, 6시 전에는 그냥 카페|9|yes
연남동 감나무집|restaurant|37.5622|126.9250|연남|웨이팅 2시간인데 그럴 만함|12|yes
책발전소 연남|shop|37.5631|126.9241|연남|비 오는 날|34|yes
대림창고 갤러리 커피|cafe|37.5412|127.0601|성수|루프탑 뷰|0|no
성수연방|shop|37.5399|127.0567|성수||1|no
포인트오브뷰 성수|shop|37.5430|127.0545|성수|문구 좋아하면 한 시간은 순삭|3|no
ROWS

saved=$(psql "$DB" -At -c \
  "select count(*) from saved_places sp join users u on u.id = sp.user_id where u.email = '$HOME_EMAIL';")
# least(…, 10) because listPlacesNearby() takes ten — counting rows the map will
# never draw would make this line a claim about the database, not about the screen.
nearby=$(psql "$DB" -At -c \
  "select least(count(*), 10) from places p where p.area = '성수'
     and not exists (select 1 from saved_places sp join users u on u.id = sp.user_id
                      where sp.place_id = p.id and u.email = '$HOME_EMAIL');")

cat <<SUMMARY

  password for both: $PASSWORD

  $NEW_EMAIL   → /onboarding, step 1 of 5
  $HOME_EMAIL  → /home, $saved saved places, $nearby pins on 성수 근처
SUMMARY
