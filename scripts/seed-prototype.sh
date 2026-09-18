#!/usr/bin/env bash
# Seeds realistic fixtures for the saved-places direction prototype.
# Goes through the real API, so it also proves the routes work, then backdates
# saved_at directly (the API deliberately has no way to set it).
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
LOG="${DEV_LOG:-/tmp/gaja-dev.log}"
DB="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
JAR="${JAR:-/tmp/proto-jar.txt}"
EMAIL="${EMAIL:-proto@example.com}"

rm -f "$JAR"
curl -s -c "$JAR" -X POST "$BASE/api/auth/magic-link" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"intent\":\"sign_in\"}" >/dev/null
T=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1 | sed 's/token=//')
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/session" -H 'content-type: application/json' \
  -d "{\"token\":\"$T\"}" >/dev/null
echo "signed in as $EMAIL"

# name | category | lat | lng | area | hook | days-ago
# Deliberately awkward: a 24-char Korean name, a hook longer than any card, a
# place with no hook at all, and three areas so grouping has something to group.
while IFS='|' read -r name cat lat lng area hook ago; do
  [ -z "${name:-}" ] && continue
  pid=$(curl -s -b "$JAR" -X POST "$BASE/api/places" -H 'content-type: application/json' \
    -d "{\"name\":\"$name\",\"category\":\"$cat\",\"lat\":$lat,\"lng\":$lng,\"area\":\"$area\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
  [ -z "$pid" ] && { echo "  skip $name"; continue; }
  hookjson=$([ -n "$hook" ] && echo "\"$hook\"" || echo null)
  sid=$(curl -s -b "$JAR" -X POST "$BASE/api/saved-places" -H 'content-type: application/json' \
    -d "{\"place_id\":\"$pid\",\"hook\":$hookjson}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')
  [ -n "$sid" ] && psql "$DB" -q -c \
    "update saved_places set saved_at = now() - interval '$ago days' - (random()*interval '8 hours') where id = '$sid';"
  printf '  + %-26s %-6s %s\n' "$name" "$area" "${ago}d ago"
done <<'ROWS'
어니언 성수|cafe|37.5445|127.0557|성수|티라미수가 미쳤다|0
대림창고 갤러리 커피|cafe|37.5412|127.0601|성수|루프탑 뷰|0
성수연방|shop|37.5399|127.0567||1
자그마치|cafe|37.5447|127.0553|성수|웨이팅 없는 오전이 답|1
디뮤지엄|exhibition|37.5385|127.0489|성수|전시 끝나기 전에 꼭|3
포인트오브뷰 성수|shop|37.5430|127.0545|성수|문구 좋아하면 한 시간은 순삭|3
블루보틀 한남|cafe|37.5348|127.0011|한남|조용하고 자리 넓음|5
사운즈한남|shop|37.5351|127.0037|한남||5
리움미술관|exhibition|37.5385|126.9990|한남|예약 필수, 주말은 오픈런|5
오라운지 한남동 루프탑 바|restaurant|37.5340|127.0025|한남|노을 시간 맞춰서 가야 의미 있음, 6시 전에는 그냥 카페|9
연남동 감나무집|restaurant|37.5622|126.9250|연남|웨이팅 2시간인데 그럴 만함|12
모모스커피 연남|cafe|37.5608|126.9262|연남|원두 사올 것|12
연남장|shop|37.5640|126.9255|연남||20
책발전소 연남|shop|37.5631|126.9241|연남|비 오는 날|34
ROWS
echo "done"
psql "$DB" -At -c "select count(*) || ' saved places for ' || (select email from users where id = sp.user_id) from saved_places sp join users u on u.id = sp.user_id where u.email = '$EMAIL' group by sp.user_id, u.email;"
