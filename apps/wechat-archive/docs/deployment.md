# 服务器、Cloudflare 与 R2

## 生产入口

1. 域名 A / AAAA 指向服务器；先确认 IPv4 / IPv6 解析均可达。开放公网 80 / 443，SSH 按自己的管理策略限制。
2. `.env` 的 `DOMAIN=archive.example.com`，`APP_ORIGIN=https://archive.example.com`，二者必须一致。禁止使用通配 CORS。
3. `WECHAT_EGRESS_IP` 填服务器访问微信的真实公网出口 IP。这是管理员确认的配置值，不是假设它与网站入站 IP 相同。多出口主机先固定微信请求出口。
4. 按 README 生成密钥、构建、启动数据库、执行迁移，再启动其他服务。
5. Caddy 自动申请 HTTPS 证书；确认日志没有证书错误，再初始化管理员。

仅 Caddy 发布生产主机端口。PostgreSQL、Redis、API、浏览器与代理没有公网端口。`browser_net` 为 Docker internal 网络，Chromium 只能通过受限 CONNECT 代理访问允许的微信域名；代理验证 DNS 解析结果，拒绝内网地址。浏览器使用非 root 用户及官方 Playwright seccomp 配置，仅额外保留 Chromium 用户命名空间沙箱需要的 SYS_CHROOT 能力，不开放 CDP / 调试端口。

在禁止非特权 user namespace 的 Linux 主机，Chromium 沙箱可能启动失败。应调整主机的容器沙箱支持或采用支持该隔离模式的主机；不要把浏览器改成 root、特权模式或关闭沙箱来通过生产验收。查看 `docker compose logs browser` 确认原因。

Compose 默认不信任转发的客户端 IP，因此登录限流以 Caddy 地址为同一来源共享。内部小团队可以使用此默认值。需要按真实 IP 限流时，将 front 网络配置固定 CIDR，并仅把该 CIDR 写入 `TRUSTED_PROXY_CIDR`；不能设置任意来源都可信。开启 Cloudflare 后，还需由 Caddy 只信任 Cloudflare 官方 IP 段，再向应用传递真实 IP；未配置前保持默认，不依据任意 `X-Forwarded-For` 放行。

## 密钥

`secrets/` 在主机上为 0700，仅部署用户可进入。单个秘密文件为 0444，目的是允许 Docker Secret 只读挂载后的非 root 服务读取；父目录权限阻止其他主机用户读取。不要把这个目录作为网站根目录，不要提交 Git。

| 文件 | 用途 |
|---|---|
| `database_password` / `database_url` | PostgreSQL 连接 |
| `encryption_key` | AES-256-GCM 主密钥，绑定账号 / 用途的 AAD |
| `browser_token` | API / Worker 调用内部浏览器服务 |
| `bootstrap_token` | 仅首次初始化可用 |
| `backup_key` | 加密备份包，独立于凭据加密主密钥 |

主密钥丢失会导致官方凭据、会话与 TOTP 无法解密；备份密钥丢失会导致备份无法恢复。两者分别离线备份。`init-secrets.mjs` 不覆盖现存文件。替换主密钥不是常规配置修改，不能直接生成新值覆盖旧值。

## Cloudflare 域名代理与 Access

服务仍在自己的服务器运行。将 Cloudflare DNS 指向服务器，SSL / TLS 使用 **Full (strict)**。先确保源站 HTTPS 正常，再打开代理。`/api/*`、HTML 和归档下载全部绕过公共缓存，不要对该子域应用 Cache Everything；应用也返回 `no-store` 或私有缓存头。

可在 Cloudflare Access 中为整个归档域名添加团队访问策略，作为应用密码和 TOTP 之外的入口保护。保持应用自身的账号权限检查。扫码状态和图片在同域内通过鉴权 API 获取，不需要向公网暴露浏览器服务。

普通 Workers 套餐并不提供本项目所需的默认固定出口，且不运行这里的完整持久化 Chromium / PostgreSQL / Redis 组合。因此不提供把 Compose 一键转换为纯 Workers 的配置。参见 [Cloudflare 专用出口 IP](https://developers.cloudflare.com/cloudflare-one/traffic-controls/egress-policies/dedicated-egress-ips/) 与 [微信稳定令牌接口](https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken.html)。

## 私有 R2

创建私有 R2 桶，禁用公共 `r2.dev` 与公开自定义域名。创建只限该桶的读写 API 令牌。配置：

```dotenv
STORAGE_DRIVER=s3
S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=wechat-archive
S3_ACCESS_KEY_ID=配置到服务器环境
S3_SECRET_ACCESS_KEY=配置到服务器环境
```

生产可用 `S3_ACCESS_KEY_ID_FILE` / `S3_SECRET_ACCESS_KEY_FILE` 指向自行挂载的 Docker Secret，避免把凭据放在 `.env`。接口只返回应用内鉴权下载，不生成公开对象 URL。SDK 使用 R2 支持的 S3 操作，并把请求校验和计算设置为 WHEN_REQUIRED。参见 [R2 S3 兼容接口](https://developers.cloudflare.com/r2/api/s3/api/)。实际 R2 凭据和网络仍需在目标环境做真实联调。

初次选择 R2 直接启动即可。迁移既有目录存储时：

```bash
docker compose stop api worker
# 保持当前 STORAGE_DRIVER=local，但先补齐 S3 配置。
docker compose run --rm ops node --import tsx scripts/storage-migrate.ts to-s3
# 命令逐对象复制并校验 SHA-256；任何不一致会停止，原件不删除。
# 全部成功后修改 STORAGE_DRIVER=s3，然后重建容器环境：
docker compose up -d --force-recreate api worker
```

对象 key 在两个存储驱动下保持一致，因此数据库引用无需改写。验证搜索、预览图片、新建导出和备份后再处理旧副本。反向迁移用 `to-local`，并确保服务器空间足够。兼容存储如 MinIO 可额外配置 `S3_FORCE_PATH_STYLE=true`，R2 通常保持默认 false。

## 容量与版本

服务器初始建议不是性能保证。图片大小、文章排版和微信限流是主要变量。限制单张图片 25MB / 4,000 万像素、HTML 8MB；正文并发 1、图片并发 3，全局任务并发 2，导出最多 1,000 篇 / 预计 2GiB。超出图片限制会显示缺失，不静默忽略。

当前镜像锁定 Node 24.22.2、PostgreSQL 18.6、Redis 7.4.7、Caddy 2.10.2，Chromium 与 Playwright 1.64.1 一同构建。发布后应持续关注安全更新，升级锁定版本并重新验收；不使用 `latest`。浏览器 seccomp 配置来自 [Playwright 官方 Docker 文件](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json)。
