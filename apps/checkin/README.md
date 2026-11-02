# 扫码签到 · tools.junbao.ai/checkin/

微信扫码打开网页，输入姓名即签到；不需要微信登录或授权。签到页下方实时显示签到顺序和时间（北京时间）。

| 地址 | 用途 |
| --- | --- |
| `/checkin/` | 签到页（手机） |
| `/checkin/screen` | 大屏：二维码 + 实时名单，适合投影 |
| `/checkin/admin` | 管理：改活动名称、删除单条、导出 CSV、清空开始新一场（需要管理口令） |
| `/checkin/qr.svg` | 签到二维码（指向 `https://tools.junbao.ai/checkin/`） |

- 单文件 Node 服务（`server.mjs`），无依赖、无数据库；数据保存在 `data/checkins.json`。
- 同名（忽略空格与大小写）不能重复签到；姓名最长 20 字；每个 IP 每分钟最多 40 次签到（同一场地 Wi-Fi 共用出口 IP）。
- 页面不加载任何外部字体或脚本，适配微信内置浏览器。
- 本机试运行：`ADMIN_TOKEN=至少12位口令 PORT=4500 node server.mjs`，打开 `http://127.0.0.1:4500/`。

## 部署（同机 Caddy，已有 `junbao-prompt_default` 网络）

```bash
cd /opt/junbao-site && git fetch -q origin main && git reset -q --hard origin/main
mkdir -p /opt/junbao-checkin && cp -a apps/checkin/. /opt/junbao-checkin/
cd /opt/junbao-checkin && mkdir -p data && chown 1000:1000 data
[ -f .env ] || { umask 077; echo "ADMIN_TOKEN=$(openssl rand -hex 16)" > .env; }
docker compose up -d && docker compose ps
```

然后把 `Caddyfile.snippet` 的内容放进现有 `tools.junbao.ai { … }` 站点块、最后那个 `handle {`（工具箱汇总页）**之前**，按文藏部署说明的方式先 `caddy validate` 再原位写入并 `caddy reload`。最后按 `apps/tools-hub/README.md` 重新构建并发布汇总页，使「扫码签到」出现在工具列表里。

验证：`curl -s https://tools.junbao.ai/checkin/healthz` 返回 `{"ok":true}`。

管理口令：`cat /opt/junbao-checkin/.env`。更新代码：重复前两行复制命令后 `docker compose restart`；`data/` 与 `.env` 不会被覆盖。

## 停用

`docker compose down`（保留 `data/`），从 Caddy 删除该片段并 reload，从 `apps/tools-hub/tools.json` 删除条目后重新发布汇总页。
