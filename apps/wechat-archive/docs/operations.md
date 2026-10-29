# 运维与恢复

## 常规检查

```bash
docker compose ps
docker compose logs --tail 100 api worker browser
docker compose exec -T db pg_isready -U archive -d archive
docker compose exec -T redis redis-cli ping
```

网页“设置与成员”显示磁盘剩余、Worker 心跳 / 队列数量和最后一次备份结果；“任务中心”显示授权失效、冷却、失败条目与完整性报告。Worker 心跳超过 2 分钟不更新需检查；任务队列丢失时 PostgreSQL 中的任务和 outbox 会重新派发。对服务器停机、磁盘满等导致网页本身不可用的故障，需要部署环境自己的主机监控。

容器日志使用大小轮转（每容器 10MB × 5），不是无限日志。Linux 生产部署可叠加 `deploy/compose.journald.yaml`（Compose ≥ 2.24.4），并在主机 journald 设置 `MaxRetentionSec=30day`，实现 30 天日志保留；也可接入现有日志系统。应用审计记录在 PostgreSQL 中保留 180 天。导出 ZIP 7 天过期，原文、图片、版本长期保留。

## 每日备份

运行：`sudo bash scripts/backup.sh`。脚本执行一致性的 `pg_dump -Fc`，复制不可变的 raw / assets 对象、生成 SHA-256 清单，将快照流式压缩并用独立的 AES-256-GCM 备份密钥加密。临时明文目录位于仅部署用户可进入的 `backups/staging-*`，正常退出 / 错误退出均清理。磁盘需容纳临时明文、加密包和保留副本。使用 root 运行脚本是为了清理 Docker ops 容器写入的私有文件。

生成 `backups/wechat-daily-时间.wca`，保留最近 7 份；每周一另外保留周备份，最近 4 份。ZIP 下载包不备份，恢复后按固定版本重新生成。

Ubuntu 部署可优先安装 `deploy/wechat-archive-backup.service` / `.timer`，详见阿里云香港部署手册。定时器使用明确的北京时间；不要同时启用 cron 和 timer 执行同一备份。

也可以在服务器配置每日 04:45 的 cron，例如 `/etc/cron.d/wechat-archive-backup`：

```cron
45 4 * * * root cd /opt/wechat-archive && bash scripts/backup.sh >> /var/log/wechat-archive-backup.log 2>&1
```

该时间取决于主机时区，请显式设为 Asia/Shanghai 或换算。为 cron 日志配置 logrotate 30 天。备份成功后用自己的 rsync / 私有对象存储流程将 `.wca` 复制到**另一台机器或独立存储账户**；站内成功标识仅证明本机备份生成，不能代替异机副本验证。至少一次异机恢复演练是上线条件。

若进程被 `kill -9` 或主机断电，trap 不会执行。清理超过 24 小时且没有正在执行备份的 `backups/staging-*` / `restore-*`；不要删除当前任务目录。存储 `.tmp-*` 文件由 Worker 的临时清理任务移除，正常失败时即清理。

## 空白环境恢复

1. 保留旧服务器，准备空白服务器、源码和同版镜像。
2. 恢复原有 `secrets/encryption_key` 与 `secrets/backup_key`，其余密钥可在初始化前生成；配置新数据库连接 / 存储。
3. 把 `.wca` 拷到 `backups/`，运行：

```bash
sudo bash scripts/restore.sh backups/wechat-daily-YYYY-MM-DDTHH-MM-SS.wca
```

脚本先验证加密包完整性，再恢复数据库与对象校验和。已有应用数据库时默认拒绝覆盖；确需覆盖，先备份，再显式传 `--replace-existing`。不要向脚本提供来源不明的备份。恢复会注销所有应用会话、让访问令牌重新获取、将旧 ZIP 标记过期；进行中的任务可以重新排队。后台微信登录可能失效，按网页提示重新扫码。

恢复验收：登录 / TOTP → 搜索中文正文 → 旧版本预览 → 打开图片 → 重新导出并解压 → 停启 Worker 后确认任务能继续。把恢复耗时和验证结果记录在服务器运维记录中。R2 模式也要备份对象本身，不能仅备份桶名与数据库引用。

## 升级与回滚

升级前备份数据库与对象，记录旧镜像 digest；停止 Worker / 浏览器，构建或拉取新镜像，再由 `ops` 执行 `scripts/migrate.ts`。迁移文件一旦用于生产便不可修改，应新增版本迁移。完成后启动服务，检查健康、搜索、权限和导出。

回滚时使用旧镜像 digest。兼容迁移可以仅回退代码；不兼容的数据库迁移须停止写入并恢复升级前的备份。不要对不兼容的新数据库强行运行旧代码。密钥不能在回滚时意外替换。

## 常见问题

| 状态 | 处理 |
|---|---|
| `IP_NOT_ALLOWED` | 核实真正的服务器出口 IP，手工追加白名单，然后重新测试 |
| `API_UNAUTHORIZED` | 官方接口无权限，连接后台；历史覆盖继续显示待核对 |
| `AUTH_EXPIRED` | 对应账号重新扫码 / 更新官方连接，不影响其他账号 |
| `VERIFICATION_REQUIRED` | 在网站显示的服务器登录画面完成允许的验证；不绕过验证 |
| `ACCOUNT_MISMATCH` | 退出扫码会话，确认公众号原始 ID / AppID，重新连接正确账号 |
| `SOURCE_SCHEMA_CHANGED` | 保留存档；根据当前微信页面更新 `src/browser` 或官方适配器，增加回归样例 |
| `LIST_REPEATED` | 分页可能变化，禁止把该次结果标完整；核查适配器 |
| `RATE_LIMIT` | 至少 30 分钟冷却；更长 Retry-After 优先；恢复仍失败则等待人工处理 |
| 图片缺失 | 文章详情点击“重试缺失图片”；不重新下载已完整的该版本图片 |
| Worker 不在线 | 修复数据库 / Redis / 存储连接，恢复后 outbox 重派，不手工清空业务表 |
| ZIP 过期 | 在文章库重新选择导出；原文与版本仍在 |

管理员丢失验证器时先使用一次性恢复码。若验证器与恢复码同时丢失，具有服务器管理权限的人可执行：

```bash
docker compose run --rm ops node --import tsx scripts/operations.ts reset-totp 管理员用户名
```

该操作注销相关会话，保留原密码，管理员下次登录必须重新设置验证器。
