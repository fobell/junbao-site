> **入口：[文藏](https://tools.junbao.ai/wechat-article-archive/)，[所有工具](https://tools.junbao.ai/)**。
>
> **tools.junbao.ai 同机部署**：使用 [专用部署说明](docs/tools-junbao.md) 和 `.env.tools.example`。下文与阿里云通用手册的独立 Caddy 模式不适用于已有主站共用 80/443 的服务器。

# 文藏 · 微信公众号在线归档

私有部署的团队网站。通过浏览器连接自有公众号、归档正文和图片、搜索与预览历史版本，导出包含 Markdown、本地图片、CSV 和完整性清单的 ZIP。

用户端不需要安装程序或复制 Cookie。部署形态为服务器上的 Docker Compose；Cloudflare 可提供域名代理、Access 和 R2。纯 Workers 版本不在本次交付范围内。

**阿里云香港 + Ubuntu 24.04 / 22.04：**请从 [完整部署手册](docs/aliyun-hong-kong.md) 开始，并配合 [凭证说明与登记表](docs/credentials.md)。配置域名后可执行 `sudo bash scripts/deploy.sh`；真实密钥在服务器生成，源码包不包含本机预览凭据。

## 当前实现

- 多公众号隔离、管理员 / 运营成员权限、一次性初始化、密码登录、管理员 TOTP 与一次性恢复码。
- 官方稳定令牌缓存及协调刷新、官方已发表图文分页、服务器 Chromium 扫码、账号身份校验、后台发表记录适配器、网页批量链接补充。
- 全量 / 每日增量 / 全历史核对；最近 30 天正文复查；文章版本、中文搜索、标签、原文状态与图片修复。
- PostgreSQL 进度与 outbox、BullMQ 调度、账号互斥锁与任务租约、暂停 / 继续 / 取消、冷却和崩溃恢复。
- 原始正文 HTML 私有留存、清理后的预览、Markdown 转换、真实图片解码校验、内容哈希去重。
- 固定文章版本的流式 ZIP；图片缺失与历史覆盖分开报告；受保护下载、7 天过期。
- 服务器目录和 S3 / R2 存储，校验后迁移，数据库与对象加密备份和恢复工具。

**真实账号验证尚待完成。** 自动化测试使用明确标注的验收数据验证平台功能；没有获得真实公众号的 AppID / AppSecret、管理员扫码权限，所以不能据此宣称“全部历史已导出”。后台页面变化、验证码、会话失效会显式进入待处理状态。见 [真实账号验收清单](docs/acceptance.md)。

本次已通过 40 项单元 / 集成测试、S3 模式的 12 项集成测试、网页端到端导出和空白环境恢复演练。完整范围与待验收项见 [验证记录](docs/verification.md)。

## 在当前电脑打开网站预览

**不要双击 `index.html`。** 它是 Vite 源码入口，必须通过 Web 服务打开；`file://` 地址无法运行 API、登录和任务服务。

已有 `.env` 和 `secrets/` 时，可用已构建镜像启动独立的预览环境：

```bash
docker compose -p wechat-archive-preview -f compose.yaml -f compose.preview.yaml up -d --wait db redis
docker compose -p wechat-archive-preview -f compose.yaml -f compose.preview.yaml run --rm ops node --import tsx scripts/migrate.ts
docker compose -p wechat-archive-preview -f compose.yaml -f compose.preview.yaml up -d api worker browser egress-proxy
```

打开 **http://localhost:23000**。第一次使用 `secrets/bootstrap_token` 中的一次性安装凭证创建管理员。预览数据库和文件卷独立于测试与生产，不预置演示账号；日常使用时保持 Docker 和服务运行。此入口仅监听本机，正式服务器部署按下节使用 HTTPS。

停止预览：`docker compose -p wechat-archive-preview -f compose.yaml -f compose.preview.yaml stop`。再次打开时运行上面的启动命令，已有数据会保留。

## 部署到服务器

建议 Linux x86-64、4 核 / 8GB、80GB SSD、固定公网出口 IP、Docker Engine 与 Compose v2。先把本目录复制到服务器，例如 `/opt/wechat-archive`。

```bash
cp .env.example .env
# 修改 DOMAIN、APP_ORIGIN、WECHAT_EGRESS_IP；APP_ORIGIN 必须是完整 HTTPS 域名。
# 主机有 Node.js 24 时：
node scripts/init-secrets.mjs
# 主机没有 Node.js 时，可用一次性容器生成密钥：
# docker run --rm -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node scripts/init-secrets.mjs

docker compose build
docker compose up -d --wait db redis
docker compose run --rm ops node --import tsx scripts/migrate.ts
docker compose up -d
docker compose ps
```

浏览器打开配置的域名，使用服务器 `secrets/bootstrap_token` 文件里的安装凭证创建管理员，随后设置 TOTP 并妥善保存恢复码。初始化入口在存在用户后自动关闭。安装凭证不会输出到普通日志。

账号接入时填写公众号原始 ID（`gh_…`，用于扫码身份核对），可选填官方 AppID / AppSecret。先在微信后台手工把服务器出口 IP **追加**到已有白名单，再测试官方接口。系统不重置 AppSecret，也不修改微信白名单。连接后台时只扫描自己刚打开的服务器登录画面。

部署、恢复和网络说明：[服务器与 Cloudflare](docs/deployment.md) · [运维手册](docs/operations.md) · [架构与状态约定](docs/architecture.md) · [API](docs/api.md)。

## 开发与测试

使用 Node.js **24 LTS**。依赖版本和 lockfile 均已锁定。开发机只用于开发 / 验收，不是交付给运营人员的本地下载工具。

```bash
npm ci
node scripts/test-env.mjs
docker compose -f compose.test.yaml up -d
node --env-file=.env.test --import tsx scripts/migrate.ts
npm test
RUN_INTEGRATION=1 node --env-file=.env.test node_modules/vitest/vitest.mjs run
npm run typecheck
npm run build
# 生产部署预检及凭证导出工具的独立测试，不连接数据库：
node --test tests/deployment.test.mjs
```

集成测试会清空 **127.0.0.1:25432/archive** 中的应用表，仅用于独立测试库，切勿指向生产库。微信网络请求在集成测试中用确定性响应代替；数据库、鉴权、转换、文件存储、导出与 ZIP 检查真实执行。

网页验收需要在三个终端启动 API、Worker 和 Vite，再运行 Playwright：

```bash
node --env-file=.env.test --import tsx src/server/main.ts
node --env-file=.env.test --import tsx src/worker/main.ts
node --env-file=.env.test node_modules/vite/bin/vite.js --host localhost
# 新终端
npx playwright install chromium
node --env-file=.env.test node_modules/@playwright/test/cli.js test
```

Playwright 测试同样会清空测试库。截图和下载包写入忽略 Git 的 `artifacts/`；这些截图中的文章均为验收样例。不要把测试密钥、浏览器状态或测试数据库迁入生产。

## 代码位置

| 目录 | 职责 |
|---|---|
| `src/web` | React 工作台、登录与扫码交互 |
| `src/server` | Fastify API、权限、连接、存储与内容转换 |
| `src/worker` | 同步、重试、导出、调度与恢复 |
| `src/browser` | 隔离浏览器服务、后台解析、出站代理 |
| `src/shared` | 状态、适配器类型和错误约定 |
| `migrations` | 版本化 PostgreSQL 迁移，Drizzle 执行 |
| `scripts` | 安装、迁移、备份、恢复、存储迁移 |
| `tests` | 单元、数据库 / API 集成、浏览器端到端测试 |

默认配色、桌面三栏预览和手机端任务 / 下载交互均已实现。生产中不会预置示例文章。
