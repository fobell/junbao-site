#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/compose.sh
exec 9>.operation.lock
flock -n 9 || { printf "%s\n" "Another deployment, backup or restore is running." >&2; exit 1; }
umask 077
if [[ "${1:-}" == --help ]]; then
  printf '%s\n' 'Usage: sudo bash scripts/deploy.sh [--check]' 'Requires Docker Compose v2, a configured .env, and either free ports 80/443 or DEPLOYMENT_MODE=tools with the existing Caddy network. Does not install Docker or change firewalls.'
  exit 0
fi
if [[ -n "${1:-}" && "${1:-}" != --check ]]; then printf '%s\n' 'Unknown option'; exit 1; fi
command -v docker >/dev/null || { printf '%s\n' '请先按手册安装 Docker Engine 和 Compose 插件。'; exit 1; }
docker info >/dev/null
dc version
[[ -f .env ]] || { printf '%s\n' '先复制 .env.example 到 .env，再填写域名和出口 IP。'; exit 1; }

node_tool() {
  docker run --rm --network none -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node "$@"
}
origin="$(node_tool scripts/deployment-check.mjs --origin)"
if docker volume inspect wechat-archive_postgres_data >/dev/null 2>&1; then
  for key in database_password database_url encryption_key backup_key; do
    [[ -s "secrets/$key" ]] || { printf '%s\n' "已有数据库卷，但缺少 secrets/$key。请恢复原凭据，不自动生成替代密钥。"; exit 1; }
  done
fi
if [[ "$deployment_mode" == tools ]]; then
  docker network inspect junbao-prompt_default >/dev/null
fi
if [[ "$deployment_mode" == standalone ]] && command -v ss >/dev/null && [[ -z "$(dc ps -q caddy 2>/dev/null || true)" ]]; then
  if [[ -n "$(ss -H -ltn '( sport = :80 or sport = :443 )')" ]]; then
    printf '%s\n' '80 或 443 已被其他服务占用。脚本不会停止已有站点；请先安排独立入口或反向代理。'
    exit 1
  fi
fi
printf '%s\n' "配置预检通过：$origin"
[[ "${1:-}" != --check ]] || exit 0
chmod 600 .env
node_tool scripts/init-secrets.mjs
dc config --quiet
dc build api
dc build browser
dc up -d --wait --wait-timeout 180 db redis
dc run --rm ops node --import tsx scripts/migrate.ts
dc up -d --wait --wait-timeout 180
bash scripts/check-deployment.sh --internal-only
printf '\n%s\n' "服务已启动。请打开 $origin，并用 secrets/bootstrap_token 创建管理员。"
printf '%s\n' '待域名和证书就绪后运行 bash scripts/check-deployment.sh，确认公网 HTTPS。生产验收仍需真实公众号。'
