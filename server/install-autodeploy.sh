#!/usr/bin/env bash
# One-time setup: deploy prompt / class / admin.junbao.ai automatically after every push to
# fobell/junbao-prompt main. Run as root:  sudo bash /opt/junbao-site/server/install-autodeploy.sh
# Needs the read-only deploy key that update-prompt.sh already created. Undo: rm /etc/cron.d/junbao-autodeploy
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/.ssh/junbao_prompt_deploy ] || { echo "deploy key missing: run update-prompt.sh once first"; exit 1; }
cat > /etc/cron.d/junbao-autodeploy <<'CRON'
# Auto-deploy junbao-prompt (prompt/class/admin.junbao.ai) when GitHub main changes. Log: /var/log/junbao-prompt-deploy.log
*/2 * * * * root /bin/bash /opt/junbao-site/server/autodeploy-prompt >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/junbao-autodeploy
# Mark the version that is already running as done, so installing doesn't trigger a rebuild.
mkdir -p /var/lib/junbao-autodeploy
CUR=$(git -C /opt/junbao-prompt-src rev-parse HEAD 2>/dev/null || true)
[ -n "$CUR" ] && echo "$CUR" > /var/lib/junbao-autodeploy/attempted
echo "== DONE. Pushes to junbao-prompt main now go live in about 5–10 minutes."
echo "   Running now: ${CUR:0:7}. Log: /var/log/junbao-prompt-deploy.log  Status: https://junbao.ai/deploy-status.json"
echo "   If GitHub has something newer, it deploys within 2 minutes."
