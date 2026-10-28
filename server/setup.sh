#!/usr/bin/env bash
# One-time setup: clone the repo and pull updates every 2 minutes. Touches no nginx config.
set -euo pipefail
URL="${1:?usage: setup.sh <git clone url>}"
command -v git >/dev/null || (apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y git)
ROOT=$(nginx -T 2>/dev/null | python3 -c '
import sys,re
t=sys.stdin.read()
for blk in re.split(r"\n\s*server\s*\{",t):
    if re.search(r"server_name[^;]*[\s](www\.)?junbao\.ai[\s;]",blk):
        m=re.search(r"^\s*root\s+([^;]+);",blk,re.M)
        if m: print(m.group(1).strip()); break
' || true)
[ -z "$ROOT" ] && [ -d /var/www/junbao.ai ] && ROOT=/var/www/junbao.ai
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then echo "!! could not find the folder junbao.ai is served from; nothing changed"; exit 1; fi
echo "$ROOT" > /etc/junbao-sync.conf
cp -a "$ROOT" "$ROOT.bak.$(date +%Y%m%d%H%M%S)"
rm -rf /opt/junbao-site && git clone -q "$URL" /opt/junbao-site
install -m 755 /opt/junbao-site/server/junbao-sync /usr/local/bin/junbao-sync
echo '*/2 * * * * root /usr/local/bin/junbao-sync >/dev/null 2>&1' > /etc/cron.d/junbao-sync
/usr/local/bin/junbao-sync --force
echo "== DONE. Site folder: $ROOT. Updates pushed to GitHub go live within 2 minutes. Log: /var/log/junbao-sync.log"
