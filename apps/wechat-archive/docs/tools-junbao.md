# tools.junbao.ai 同机部署与恢复

目标：Ubuntu 24.04 x86-64，2 核约 4GB，安装目录 `/opt/wechat-archive`。主站和提示词站继续使用原来的 Caddy；工具没有任何宿主机端口映射。

## 入口与路径

- 汇总页：`https://tools.junbao.ai/`，静态内容来自仓库 `apps/tools-hub/`。
- 文藏：`https://tools.junbao.ai/wechat-article-archive/`。
- `.env` 设置 `APP_ORIGIN=https://tools.junbao.ai` 和 `APP_BASE_PATH=/wechat-article-archive`；Origin 不包含路径。修改基础路径必须重新构建应用镜像，Docker 会检查构建路径与运行配置一致。
- 公开健康地址：`/wechat-article-archive/healthz`；内部容器仍检查 `/healthz`。公开 API 基址为 `/wechat-article-archive/api/v1`，Caddy 移除前缀后转发内部原接口。
- 页面、API、图片和下载使用私有缓存策略；登录 Cookie 限定在工具路径，登录时清理旧根路径 Cookie。首次访问旧入口现在进入汇总页；旧根目录 API 不再提供服务。
- 历史预览在 API 输出时转换本地图片地址，数据库与导出包中原有内容不改写。账号、TOTP、密钥及数据卷继续沿用。

## 安装与配置

1. 使用 GitHub 中已验证的版本，将本应用目录复制到 `/opt/wechat-archive`，记录 Git 提交 SHA。不要从主站自动更新目录直接运行应用。
2. 首次安装复制 `.env.tools.example` 为 `.env`，权限设为 `0600`。核实实际公网出口 IP，以及 `junbao-prompt_default` 网络的 CIDR；`TRUSTED_PROXY_CIDR` 只能信任实际反向代理网络。
3. DNS 添加 `tools` 的 A 记录到服务器地址；没有可达 IPv6 时不添加 AAAA。现有 HTTP/HTTPS 和 SSH 规则已足够。
4. `bash scripts/deploy.sh --check` 后执行 `bash scripts/deploy.sh`。`DEPLOYMENT_MODE=tools` 选择完整的 `compose.tools.yaml`，构建顺序为 API、浏览器；先等数据库健康再执行迁移。
5. 先构建并发布汇总页到 `/var/www/junbao.ai/tools-hub/current`，步骤见 `apps/tools-hub/README.md`。备份现有 Caddyfile，将 `deploy/tools.Caddyfile` 的站点块追加到现有配置（升级时只替换已有 tools 站点块），容器内执行 `caddy validate`，成功后 `caddy reload`。不要替换整个 Caddyfile。该配置以单文件挂载：先验证候选文件，再把内容写入现有文件以保持 inode，避免容器继续读旧配置。
6. 执行 `bash scripts/check-deployment.sh`，同时复核主站首页和提示词站 `/api/health`。

应用通过外部网络别名 `wechat-archive-api` 被原 Caddy 访问；数据库、Redis、浏览器、出站代理不加入该网络。API 的实际端口为容器内 3000。

所有生产运维脚本共用 `scripts/compose.sh`。不要设置 `COMPOSE_FILE`、`COMPOSE_PROJECT_NAME` 或 `COMPOSE_PROFILES`，避免误操作不同项目。手工命令使用 `docker compose -f compose.tools.yaml …`。恢复流程也不会启动独立 Caddy。

## 小内存配置

全局队列和单 Worker 并发为 1；扫码会话最多 1 个、浏览器上下文总数最多 2 个，创建中也占名额。繁忙返回可重试错误，关闭、超时、取消和失败释放资源。

容器内存上限：API 256MiB、Worker 512MiB、浏览器 1024MiB、数据库 384MiB、Redis 192MiB、出站代理 128MiB、临时运维容器 384MiB。Redis 使用 128MB 数据上限和 noeviction，避免悄悄删除任务。主机配置 2GiB swap、swappiness=10；swap 不是提高采集并发的依据。

部署、备份和恢复使用同一操作锁，禁止重叠执行。Chromium 保持非 root、沙箱开启和限制出站网络；不要用 `--no-sandbox` 或关闭主机 AppArmor 解决故障。

## 初始化与秘密

管理员在网站输入服务器 `secrets/bootstrap_token` 后自行设置用户名、密码及 TOTP。没有默认账号。生产库不导入验收样例。

使用 `scripts/credential-sheet.mjs --include-secrets` 可生成 `0600` 的 `secrets/credential-sheet.local.json`，仅进入私人密码库或受限本地文件。密钥、`.env`、会话、数据和备份均被 Git 排除；不要粘贴到公开 Issue 或日志。

公众号 AppID/AppSecret、管理员扫码和出口 IP 白名单在首次登录后由拥有者完成。服务健康不代表真实公众号历史完整性已验收。

## 备份、升级与回滚

先执行 `bash scripts/backup.sh`，再安装 `deploy/wechat-archive-backup.service` 和 timer 到 systemd。每天北京时间 04:45 开始，随机延后最多 5 分钟，保留 7 日与 4 周备份。本次仅服务器本地备份，没有自动异地副本；加密主密钥与备份密钥需单独保管。

恢复演练必须使用独立数据库和对象卷，解密验证哈希后确认正文、图片和重新导出。真实恢复遵循 `docs/operations.md`，使用匹配的旧加密密钥，绝不在运行中覆盖数据库。

升级前先备份，保存当前源码、环境配置与镜像 ID；停止工具的 API、Worker、浏览器后切换源码，保留 `.env`、`secrets/`、`backups/` 与数据卷。重建、迁移、启动并检查；不运行主站的 `server/setup.sh`。

首次上线失败：恢复之前的 Caddyfile并校验、reload；停止工具项目的服务，保留持久化数据。后续代码回滚须使用兼容的数据库版本；有不兼容迁移时先停止工具服务，再恢复对应备份。不要使用 `docker compose down -v`。

## 验收标准

运行 `npm run check`，并在独立 PostgreSQL/Redis 环境运行 集成测试和完整 Playwright 场景。测试禁止指向生产库。

服务器侧检查 HTTPS、初始化页、内部健康、沙箱浏览器与公开微信登录页、无额外公开端口、备份恢复和持久性。15 分钟单任务观察期间无 OOM、持续重启或原站故障，可用内存应至少 512MiB。实际公众号登录与历史覆盖、R2 和异地恢复另行验收。

原交付 ZIP SHA-256：`637ef34848f21f8ed4004d8b4a9555e8db628dc7c4e60c84a0315fa6dc6a3fb9`。

## 本次路径迁移与回滚

见 [迁移记录](tools-path-migration.md)。迁移前保留原应用源码、镜像 ID、`.env`、Caddyfile 与加密备份。回滚时先恢复应用源码和 `.env`，使用旧镜像重建受影响的 API / Worker / 出站代理，再原位恢复 Caddyfile 内容并 validate / reload；删除或替换汇总页当前符号链接即可撤回入口。本次没有数据库迁移，不需要恢复数据库，也不要删除数据卷。

仅首页内容调整时，按工具箱说明切换静态发布目录即可。`server/junbao-sync` 继续只发布个人主站。
