#!/usr/bin/env bash
# Update prompt.junbao.ai (+ class.junbao.ai, admin.junbao.ai) on the Hong Kong server from GitHub.
#
#   The code repository is private, so this script is also published in the public junbao-site repo,
#   which the server already syncs to /opt/junbao-site. Run as root:
#     bash /opt/junbao-site/server/update-prompt.sh
#   First run prints a read-only deploy key to add on GitHub, then exits; run it again after adding the key.
#   Later updates: the same command.
#
# What it does, in order (any failure stops it; nothing is half-switched):
#   1. fetch fobell/junbao-prompt main into /opt/junbao-prompt-src (read-only deploy key)
#   2. encrypted database backup (existing junbao-backup.service) and tag the running image for rollback
#   3. copy code into /opt/junbao-prompt, keeping .env, .local, data, compose.yaml, Dockerfile and the live Caddyfile
#   4. add the class/admin settings (compose.override.yaml) and Caddy site block if missing, validated before reload
#   5. rebuild and restart only the app, wait for health, check all three sites
set -euo pipefail
REPO=git@github.com:fobell/junbao-prompt.git
SRC=/opt/junbao-prompt-src
APP=/opt/junbao-prompt
KEY=/root/.ssh/junbao_prompt_deploy
say(){ printf '\n== %s\n' "$*"; }
die(){ printf '\n!! %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$APP" ] || die "$APP not found"

say "1/5 source"
if [ ! -f "$KEY" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  ssh-keygen -q -t ed25519 -N '' -C "junbao-prompt deploy $(hostname)" -f "$KEY"
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if ! git ls-remote "$REPO" HEAD >/dev/null 2>&1; then
  echo
  echo "This server can't read the private repository yet. Add this public key on GitHub:"
  echo "  github.com/fobell/junbao-prompt → Settings → Deploy keys → Add deploy key (leave 'Allow write access' OFF)"
  echo
  cat "$KEY.pub"
  echo
  echo "Then run this same command again."
  exit 2
fi
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q origin main && git -C "$SRC" reset -q --hard origin/main
else rm -rf "$SRC" && git clone -q "$REPO" "$SRC"; fi
REV=$(git -C "$SRC" rev-parse --short HEAD); echo "source at $REV"

say "2/5 backup and rollback point"
cd "$APP"
if systemctl list-unit-files junbao-backup.service >/dev/null 2>&1 && systemctl cat junbao-backup.service >/dev/null 2>&1; then
  systemctl start junbao-backup.service && echo "encrypted backup done: $(cat /var/backups/junbao-prompt/status.json 2>/dev/null | head -c 200)"
else echo "junbao-backup.service not installed; skipping (data volume is untouched by this update)"; fi
OLD=$(docker compose images -q app 2>/dev/null | head -1 || true)
if [ -n "$OLD" ]; then TAG="junbao-prompt-app:before-$REV-$(date +%Y%m%d%H%M%S)"; docker tag "$OLD" "$TAG"; echo "rollback image: $TAG"; echo "$TAG" > "$APP/.last-rollback-image"; fi

say "3/5 code"
for d in src server shared public scripts tests docs assets; do
  [ -d "$SRC/$d" ] && { mkdir -p "$APP/$d"; cp -a "$SRC/$d/." "$APP/$d/"; }
done
# remove source files that no longer exist upstream (only inside code folders)
for d in src server shared tests; do
  (cd "$APP/$d" && find . -type f) | while read -r f; do [ -e "$SRC/$d/$f" ] || rm -f "$APP/$d/$f"; done
done
for f in package.json package-lock.json index.html tsconfig.json vite.config.ts playwright.config.ts README.md PROJECT_DOCUMENTATION.md metadata.json .dockerignore .gitignore .env.example deploy/sites.Caddyfile deploy/server-update.sh deploy/junbao-backup.service deploy/junbao-backup.timer; do
  [ -f "$SRC/$f" ] && { mkdir -p "$APP/$(dirname "$f")"; cp -a "$SRC/$f" "$APP/$f"; }
done
echo "kept as-is: .env .local data compose.yaml Dockerfile deploy/Caddyfile"

say "4/5 settings for class / admin"
OVR="$APP/compose.override.yaml"
if [ ! -f "$OVR" ]; then
  cat > "$OVR" <<'YAML'
# Added by deploy/server-update.sh: course site, admin site and one shared login.
services:
  app:
    environment:
      CLASS_ORIGIN: https://class.junbao.ai
      ADMIN_ORIGIN: https://admin.junbao.ai
      COOKIE_DOMAIN: junbao.ai
      UPLOAD_DIR: /app/data/uploads
YAML
  echo "wrote compose.override.yaml"
elif ! grep -q CLASS_ORIGIN "$OVR"; then die "$OVR exists without CLASS_ORIGIN; merge the settings from deploy/server-update.sh by hand"
else echo "compose.override.yaml already present"; fi
grep -q 'CLASS_ORIGIN' compose.yaml || true
CF="$APP/deploy/Caddyfile"
if grep -q 'class.junbao.ai' "$CF"; then echo "Caddy: class/admin block already present"
else
  BAK="$CF.bak-sites-$(date +%Y%m%d%H%M%S)"; cp -a "$CF" "$BAK"; echo "Caddy backup: $BAK"
  CAND=$(mktemp); { cat "$CF"; echo; cat "$APP/deploy/sites.Caddyfile"; } > "$CAND"
  docker compose cp "$CAND" caddy:/tmp/Caddyfile.sites >/dev/null
  docker compose exec -T caddy caddy validate --config /tmp/Caddyfile.sites --adapter caddyfile >/dev/null || { rm -f "$CAND"; die "candidate Caddyfile failed validation; nothing changed"; }
  RELOAD_CADDY=1
fi

say "5/5 build and restart the app"
build(){ docker compose build "$@" app; }
build || { echo "Docker Hub slow? retrying with the AWS public mirror"; build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim; }
docker compose up -d app
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo starting)
  [ "$s" = healthy ] && break; sleep 2
  [ "$i" = 60 ] && { docker compose logs --tail 60 app; die "app not healthy. Roll back: docker tag \$(cat $APP/.last-rollback-image) junbao-prompt-app && docker compose up -d --no-build app"; }
done
echo "app healthy"
if [ "${RELOAD_CADDY:-}" = 1 ]; then
  cat "$CAND" > "$CF"; rm -f "$CAND"   # in place: keeps the inode of the single-file bind mount
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || { cat "$BAK" > "$CF"; docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; die "Caddy reload failed; Caddyfile restored"; }
  echo "caddy reloaded"
fi

echo
sleep 3
for h in prompt class admin; do
  printf '%-8s ' "$h"; curl -fsS --max-time 20 "https://$h.junbao.ai/api/health" || printf 'not reachable yet (DNS or certificate still pending?)'; echo
done
echo
echo "Deployed $REV. Course: https://class.junbao.ai  Admin: https://admin.junbao.ai"
