#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/compose.sh
dc ps
dc exec -T db pg_isready -U archive -d archive
dc exec -T redis redis-cli ping
dc exec -T api node --input-type=module <<'JS'
import { config } from './dist/server/server/config.js';
import { pool } from './dist/server/server/db.js';
try {
  const api = await fetch('http://127.0.0.1:3000/healthz', { signal: AbortSignal.timeout(10000) });
  if (!api.ok || !(await api.json()).ok) throw new Error('API health failed');
  const browser = await fetch(`${config.browserUrl}/`, { headers: { authorization: `Bearer ${config.browserToken}` }, signal: AbortSignal.timeout(10000) });
  if (browser.status !== 404) throw new Error('Browser service is unavailable or its token does not match');
  const result = await pool.query("SELECT updated_at FROM system_status WHERE key='worker'");
  if (!result.rows[0] || Date.now()-new Date(result.rows[0].updated_at).getTime()>120000) throw new Error('Worker heartbeat is missing or stale');
  console.log('API, browser process, database and worker heartbeat: OK. WeChat account access has not been tested by this check.');
} finally { await pool.end(); }
JS
if [[ "${1:-}" != --internal-only ]]; then
  origin="$(docker run --rm --network none -v "$PWD:/work:ro" -w /work node:24.22.2-bookworm-slim node scripts/deployment-check.mjs --url)"
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 30 "${origin%/}/healthz")"
  if [[ "$status" != 200 ]]; then
    printf '%s\n' "公网 HTTPS 返回 HTTP $status；检查 DNS / TLS / 安全组。如果已启用 Access，请在浏览器登录后核验。"
    exit 1
  fi
  printf '%s\n' "公网 HTTPS 正常：$origin"
fi
