#!/usr/bin/env bash
# One-shot install / update of 扫码签到 at https://tools.junbao.ai/checkin/
# Run on the server as root:  cd /opt/junbao-site && git fetch -q origin main && git reset -q --hard origin/main && bash server/deploy-checkin.sh
# Safe to re-run: keeps data/ and .env, only adds the Caddy route once, backs up the Caddyfile and validates before reloading.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/junbao-checkin
say(){ printf '\n== %s\n' "$*"; }
die(){ printf '\n!! %s\n' "$*" >&2; exit 1; }

say "1/4 app → $APP"
mkdir -p "$APP"
cp -a "$REPO/apps/checkin/." "$APP/"
mkdir -p "$APP/data" && chown 1000:1000 "$APP/data"
if [ ! -f "$APP/.env" ]; then (umask 077; echo "ADMIN_TOKEN=$(openssl rand -hex 16)" > "$APP/.env"); fi
docker network inspect junbao-prompt_default >/dev/null 2>&1 || die "network junbao-prompt_default not found (is the Caddy / prompt project running?)"
(cd "$APP" && docker compose up -d --remove-orphans && docker compose restart >/dev/null)
for i in $(seq 1 20); do
  docker exec junbao-checkin-app-1 wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 20 ] && { (cd "$APP" && docker compose logs --tail 40); die "app did not become healthy"; }
done
echo "app healthy"

say "2/4 Caddy route /checkin/"
C=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1; exit}')
[ -n "$C" ] || die "no running Caddy container found"
SRC=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$C")
if [ -z "$SRC" ]; then
  DIR=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$C")
  [ -n "$DIR" ] && SRC="$DIR/Caddyfile"
fi
[ -n "$SRC" ] && [ -f "$SRC" ] || die "could not find the Caddyfile mounted into $C"
echo "caddy container: $C, Caddyfile: $SRC"
docker network inspect junbao-prompt_default -f '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$C" || die "$C is not on junbao-prompt_default"
if grep -q 'checkin-app:3000' "$SRC"; then
  echo "route already present"
else
  BAK="$SRC.bak-checkin-$(date +%Y%m%d%H%M%S)"; cp -a "$SRC" "$BAK"; echo "backup: $BAK"
  CAND=$(mktemp)
  python3 - "$SRC" "$REPO/apps/checkin/Caddyfile.snippet" "$CAND" <<'PY'
import re, sys
src, snip, out = sys.argv[1:4]
lines = open(src, encoding="utf-8").read().split("\n")
start = next((i for i, l in enumerate(lines) if re.match(r"^\s*tools\.junbao\.ai(\s*,[^{]*)?\s*\{\s*$", l)), None)
if start is None: sys.exit("tools.junbao.ai block not found")
depth, end = 0, None
for i in range(start, len(lines)):
    code = re.sub(r"(^|\s)#.*$", "", lines[i])
    depth += code.count("{") - code.count("}")
    if depth == 0: end = i; break
if end is None: sys.exit("tools.junbao.ai block is not closed")
hub = next((i for i in range(start + 1, end) if re.match(r"^\s*handle\s*\{\s*$", lines[i])), None)
at = hub if hub is not None else end
lines[at:at] = open(snip, encoding="utf-8").read().rstrip("\n").split("\n")
open(out, "w", encoding="utf-8").write("\n".join(lines))
print("inserted before line", at + 1)
PY
  docker cp "$CAND" "$C:/tmp/Caddyfile.checkin" >/dev/null
  docker exec "$C" caddy validate --config /tmp/Caddyfile.checkin --adapter caddyfile || { rm -f "$CAND"; die "candidate Caddyfile failed validation; nothing changed"; }
  cat "$CAND" > "$SRC"   # write in place: keeps the inode of the single-file bind mount
  rm -f "$CAND"
  docker exec "$C" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || { cat "$BAK" > "$SRC"; docker exec "$C" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; die "reload failed; Caddyfile restored"; }
  echo "caddy reloaded"
fi

say "3/4 tools hub (adds the 扫码签到 card)"
if command -v node >/dev/null; then node "$REPO/apps/tools-hub/build.mjs"
else docker run --rm -v "$REPO/apps/tools-hub":/hub -w /hub node:22-alpine node build.mjs; fi
if [ -d /var/www/junbao.ai/tools-hub ]; then bash "$REPO/server/publish-tools-hub.sh" "$REPO/apps/tools-hub/dist" "hub-$(date +%Y%m%d%H%M%S)"
else echo "tools hub folder not found; skipped"; fi

say "4/4 check"
sleep 1
curl -fsS --max-time 10 https://tools.junbao.ai/checkin/healthz && echo || echo "public check failed — see above"
echo
echo "签到页:  https://tools.junbao.ai/checkin/"
echo "大屏:    https://tools.junbao.ai/checkin/screen"
echo "管理:    https://tools.junbao.ai/checkin/admin"
echo "管理口令: $(grep '^ADMIN_TOKEN=' "$APP/.env" | cut -d= -f2)"
