# 文藏：阿里云香港服务器完整部署手册

适用：你已经拥有的阿里云香港 ECS，Ubuntu 24.04 LTS 或 22.04 LTS，单台服务器、Docker Compose、独立域名、Caddy 自动 HTTPS。文档日期：2026-10-29。

目标结果：团队访问 `https://你的归档域名`，创建管理员、连接自己的公众号、长期归档、搜索与下载 Markdown ZIP。所有采集和打包在服务器执行。运营人员无需安装本地工具。

## 1. 交付包与阅读顺序

下载 `wechat-archive-aliyun-hk-1.0.0.zip` 和同名 `.sha256` 校验文件，解压后顶层为 `wechat-archive/`。

| 文件 | 用途 |
|---|---|
| 本手册 `docs/aliyun-hong-kong.md` | 从新服务器到可用网站的操作顺序 |
| `docs/credentials.md` | 所有凭证的来源、存放位置、导出、保管和恢复 |
| `.env.example` | 域名、出口 IP、存储和同步时间模板 |
| `scripts/deploy.sh` | 预检、生成密钥、构建、迁移、启动和内部健康检查 |
| `scripts/check-deployment.sh` | 数据库、队列、浏览器、Worker 和公网 HTTPS 检查 |
| `scripts/credential-sheet.mjs` | 在生产服务器生成包含实际应用密钥的私密凭证清单 |
| `compose.yaml` / `Dockerfile` | 生产服务定义与可重复构建的镜像源码 |
| `deploy/wechat-archive-backup.*` | 每天北京时间 04:45 的备份服务与定时器 |
| `docs/operations.md` | 备份、恢复、升级、回滚及错误处理 |
| `docs/acceptance.md` / `docs/verification.md` | 真实账号验收清单与已执行测试记录 |
| `docs/api.md` / `docs/openapi.json` | API 使用说明和 OpenAPI 定义 |

源码包不包含本机预览凭证、测试数据库、浏览器会话和依赖目录。生产密钥在你的香港服务器生成。没有预置管理员账号或通用默认密码。

## 2. 部署前填写这张表

| 项目 | 你需要填写的值 |
|---|---|
| 香港服务器公网入站 IP | 从 ECS / EIP 控制台确认 |
| SSH 登录方式 | 服务器用户名 + 私钥，或你已经持有的服务器密码 |
| 归档域名 | 例如 `archive.你的域名.com`，需要 DNS 管理权限 |
| 实际公网出口 IP | 从 EIP / SNAT 网络配置确认；可能与入站 IP 不同 |
| 系统 | Ubuntu 24.04 或 22.04，64 位 |
| 资源 | 起步建议 4 核、8GB 内存、80GB SSD；按实际图片量与备份增长调整 |
| 现有站点 | 确认 TCP 80 / 443 没有被别的 Nginx、宝塔或网站占用 |
| 公众号接入 | 原始 ID `gh_…`；官方渠道需要已有 AppID / AppSecret；扫码需要管理员微信 |
| 异机备份位置 | 另一台机器或私有存储账户，不能仅留在同一 ECS 磁盘 |

本手册不需要阿里云 AccessKey。SSH 和域名控制台凭证由你自己持有，不填进公众号平台。

按阿里云当前说明，服务器在香港的这个部署场景不要求办理中国大陆服务器 ICP 备案；若以后改用中国大陆服务器或大陆 CDN，需重新确认对应要求。[阿里云备案地域说明](https://help.aliyun.com/en/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)

## 3. 配置阿里云安全组和域名

在 ECS 控制台找到香港实例所属安全组，配置入方向规则：

| 协议 / 端口 | 来源 | 作用 |
|---|---|---|
| TCP 22（或你实际的 SSH 端口） | 你的办公公网 IP /32 | 服务器管理 |
| TCP 80 | `0.0.0.0/0` | HTTPS 申请及跳转 |
| TCP 443 | `0.0.0.0/0` | 网站 HTTPS |

不要为本项目额外开放 3000、3001、3128、5432、6379、23000。数据库、Redis 和浏览器服务只在 Docker 内网工作。若使用 IPv6，需要同时确认对应 IPv6 安全组规则和可达性。[阿里云安全组说明](https://www.alibabacloud.com/help/en/ecs/user-guide/start-using-security-groups)

在域名 DNS 中添加 A 记录：主机记录 `archive`，记录值为服务器入站公网 IPv4。如果尚未配置可达的 IPv6，不要添加 AAAA。初次部署时先使用 DNS 直连；Cloudflare 代理在源站 HTTPS 验证后再启用。

主机如启用了 UFW，也需要放行实际 SSH 端口及 TCP 80 / 443；不要盲目重置现有防火墙。Docker 发布端口与 UFW 的关系需要单独核对，公网入口优先由 ECS 安全组约束。[Docker 防火墙说明](https://docs.docker.com/engine/install/ubuntu/)

## 4. 登录服务器并安装 Docker

在你自己的电脑终端执行；将占位符替换为实际路径、用户和 IP：

```bash
chmod 600 /路径/你的SSH私钥.pem
ssh -i /路径/你的SSH私钥.pem root@服务器公网IP
```

如果服务器只允许 `ubuntu` 等用户登录，使用该用户连接后执行 `sudo -i`。以下服务器命令按 root 执行。已有 Docker Engine 且 `docker compose version` 可用时，可跳过安装步骤。

在全新 Ubuntu 上使用 Docker 官方软件源：

```bash
apt-get update
apt-get install -y ca-certificates curl unzip dnsutils iproute2
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version
docker compose version
```

如已有旧 Docker / containerd 或其他容器业务，先按官方文档确认冲突，不要直接卸载在用组件。以上步骤采用软件源安装，没有使用远程脚本管道执行。[Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)

## 5. 上传并解压交付包

在自己的电脑终端执行：

```bash
scp -i /路径/你的SSH私钥.pem wechat-archive-aliyun-hk-1.0.0.zip root@服务器公网IP:/tmp/
scp -i /路径/你的SSH私钥.pem wechat-archive-aliyun-hk-1.0.0.zip.sha256 root@服务器公网IP:/tmp/
```

回到服务器，首次安装执行：

```bash
cd /tmp
sha256sum -c wechat-archive-aliyun-hk-1.0.0.zip.sha256
mkdir -p /opt
unzip wechat-archive-aliyun-hk-1.0.0.zip -d /opt
cd /opt/wechat-archive
```

校验必须显示 `OK`。如果 `/opt/wechat-archive` 已经是运行中的安装目录，不要直接覆盖；按第 12 节升级。

不要把根目录 `index.html` 当静态网页上传到网站根目录。它是源码入口，必须构建并启动应用服务。也不要把 `node_modules`、本机 `.env` 或本机 `secrets/` 上传到生产服务器。

## 6. 配置三个关键值

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

至少修改以下值；域名和 IP 都用你自己的实际值：

```dotenv
DOMAIN=archive.你的实际域名.com
APP_ORIGIN=https://archive.你的实际域名.com
WECHAT_EGRESS_IP=实际公网出口IP
STORAGE_DRIVER=local
SYNC_HOUR=3
SYNC_MINUTE=30
REQUEST_DELAY_MS=3000
```

域名使用小写 ASCII / Punycode，`APP_ORIGIN` 必须是对应的 HTTPS 地址，不带末尾斜线。不要复制上面中文占位符，也不要保留模板的 `archive.example.com`。

第一遍建议保持 `STORAGE_DRIVER=local`，S3 / R2 字段留空。官方白名单准备前可以暂时留空 `WECHAT_EGRESS_IP`，但之后必须核实并补齐。这个字段只负责显示，不会改变服务器网络出口。

检查域名和端口：

```bash
dig +short archive.你的实际域名.com A
ss -ltnp '( sport = :80 or sport = :443 )'
```

如果 80 / 443 被已有业务占用，停止本手册的自动部署流程。不能仅换一个子域就解决同一 IP 的端口占用，也不要为部署本项目停止不相关网站；需要接入原有反向代理或提供独立入口。

## 7. 部署应用

先检查配置，再安装：

```bash
cd /opt/wechat-archive
bash scripts/deploy.sh --check
bash scripts/deploy.sh
```

脚本不安装 Docker、不改安全组、不停止别的站点、不覆盖已有密钥。它按顺序执行：检查配置 → 生成缺失的首次安装凭证 → 构建两个镜像 → 等待数据库健康 → 执行迁移 → 启动服务 → 检查内部服务。

若已发现生产数据库卷但关键密钥缺失，脚本会停止，要求恢复原凭据。不能通过新随机密钥恢复旧加密数据。

首次构建需要从 Docker、npm 和 Playwright 官方分发位置下载依赖，耗时取决于服务器网络。自有服务器为 x86-64 时在服务器原生构建；本机验证过的 ARM64 镜像不作为 x86-64 的已验收二进制镜像交付。

随后检查：

```bash
docker compose ps
docker compose logs --tail 100 caddy
bash scripts/check-deployment.sh
```

只有内部服务正常且公网 HTTPS 检查通过后，才进入下一步。Caddy 在域名解析正确、80 / 443 可达、证书目录持久化的条件下申请和续期证书。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

脚本没有替你验证微信账号权限，也没有替你确认历史清单完整。

如果想逐步手工执行，等价命令如下：

```bash
docker run --rm --network none -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node scripts/init-secrets.mjs
docker compose config --quiet
docker compose build api browser
docker compose up -d --wait --wait-timeout 180 db redis
docker compose run --rm ops node --import tsx scripts/migrate.ts
docker compose up -d --wait --wait-timeout 180
```

## 8. 第一次打开网站：安装凭证与管理员

在自己的电脑浏览器打开 `.env` 中的 HTTPS 域名。服务器终端执行：

```bash
cd /opt/wechat-archive
cat secrets/bootstrap_token
```

复制这一串到网页的“一次性安装凭证”，填写你自己的姓名、用户名和密码。**没有默认管理员密码**，也不要使用本机验收时出现过的测试账号。

管理员随后需要设置 TOTP：用支持 TOTP 的验证器扫描二维码，填写六位验证码，保存页面给出的恢复码。这里的验证器不是公众号登录的微信扫码；两个用途不同。服务器系统时间需准确，避免验证码校验失败。

管理员创建后，初始化入口自动关闭；安装凭证不能继续创建第二个初始管理员。普通运营成员由管理员在“设置与成员”中创建并分配公众号。

## 9. 取得完整生产凭证清单

本机聊天里出现过的安装凭证只属于本机预览，不是香港服务器的凭证。服务器生成后，可执行：

```bash
cd /opt/wechat-archive
docker run --rm --network none -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node scripts/credential-sheet.mjs --include-secrets
```

输出文件为 `secrets/credential-sheet.local.json`，权限 `0600`，包含实际数据库密码、连接串、应用主密钥、浏览器服务令牌、安装凭证和备份密钥。命令不会把密钥打印到终端，不覆盖已有导出文件。

该文件仅在你的服务器生成，未放进交付 ZIP。可用 SSH / SCP 取回并转存到私有密码库。管理员自己设置的登录密码、TOTP 恢复码、阿里云私钥、微信 AppSecret 和 R2 凭据不在这份自动生成的清单中，需分别保管。详见 `docs/credentials.md`。

## 10. 接入公众号并核对第一次归档

1. 管理员打开“公众号管理”，添加公众号名称和原始 ID `gh_…`。
2. 有官方权限时填写已有 AppID / AppSecret。不要为接入本工具随意重置正在被别的系统使用的 AppSecret。
3. 在微信后台把真实公网出口 IP 追加到现有白名单，然后点击“测试官方连接”。不要把 Cloudflare 代理 IP 当作微信请求出口。
4. 如需后台补齐，点击“连接公众号后台”，使用管理员手机微信扫描网站显示的服务器登录画面。完成账号选择或人工验证后，系统必须确认账号身份一致。
5. 启动“全量同步”，在任务中心看正文、图片、渠道与历史覆盖报告。
6. 与微信后台核对最早和最新文章、非群发、群发、多图文次条。随机打开几篇正文和图片，再导出少量文章，解压并断网检查 Markdown 图片。

本项目不需要你填写公众号“服务器 URL / Token / EncodingAESKey”回调配置，也不接管消息回复。内部 `browser_token` 不是微信后台开发者 Token。

每天默认北京时间 03:30 错峰增量同步；后台会话失效时在网页重新扫码。官方渠道是否可用、后台是否要求额外验证，必须以你的真实账号结果为准。链接补充仍需核实属于已连接账号。

## 11. 配置每天备份

先人工完成一次备份，检查成功后再启用定时器：

```bash
cd /opt/wechat-archive
bash scripts/backup.sh
install -m 0644 deploy/wechat-archive-backup.service /etc/systemd/system/
install -m 0644 deploy/wechat-archive-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wechat-archive-backup.timer
systemctl list-timers wechat-archive-backup.timer
```

定时器使用明确的 `Asia/Shanghai` 时区，每天 04:45 起、最多随机延后 5 分钟；系统关机错过的任务会在恢复后补触发。不要再同时配置同一任务的 cron。[systemd 定时器说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

备份保留 7 份日备份、4 份周备份；周备份按北京时间星期一生成。导出 ZIP 不备份，恢复后重新导出。原文和图片长期保存，导出 ZIP 7 天过期。

查看备份日志：

```bash
journalctl -u wechat-archive-backup.service --since today --no-pager
```

把加密 `.wca` 复制到另一台机器或私有对象存储。另行保管 `encryption_key` 与 `backup_key`；仅有 `.wca` 不能替代密钥备份。若更改安装目录，先修改 service 的 `WorkingDirectory` 与 `ExecStart`。

## 12. 重启、升级、恢复

常规重启不删除数据：

```bash
cd /opt/wechat-archive
docker compose restart api worker browser
docker compose ps
```

容器设置了 `unless-stopped`，Docker 启动后会恢复未被主动停止的服务。正常运维不要执行 `docker compose down -v`，它会删除持久化卷；也不要对业务卷运行清理命令。

升级：先备份并记录当前镜像 ID → 安排维护时段 → 停止 API / Worker / 浏览器 → 更新源码但保留 `.env`、`secrets/`、备份和卷 → 构建 → 迁移 → 启动 → 重新检查连接、搜索和导出。不要用交付模板覆盖真实密钥。

空白服务器恢复：准备同版源码、Docker 和配置，恢复旧 `encryption_key` / `backup_key`，再生成其余必要密钥、构建镜像并上传 `.wca`。随后按 `docs/operations.md` 执行 `scripts/restore.sh`。新数据库的连接密码可以重新生成；用于解密旧业务数据和备份包的密钥必须保持原值。

至少完成一次异机恢复并验证图片和重新导出，才算备份链路可用。

## 13. Cloudflare / R2 可选接入

可以先不使用 Cloudflare，完整功能都能在服务器运行。

需要代理域名时，先确认源站 HTTPS，随后将 Cloudflare SSL / TLS 设为 **Full (strict)**；整个归档子域的 HTML 和 `/api/*` 绕过公共缓存。Access 可增加团队入口限制，但不能替代应用账号权限。[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

需要 R2 时，创建私有桶和限定该桶的 S3 访问凭据，将对应字段填进受保护的 `.env` 或按 `docs/deployment.md` 挂载 Docker Secret。S3 Access Key ID / Secret Access Key 不是阿里云 AccessKey，也不是 Cloudflare 全局 API Key。[R2 凭据说明](https://developers.cloudflare.com/r2/api/tokens/)

已有数据时必须先运行存储迁移并核对哈希，成功后才切换 `STORAGE_DRIVER=s3`。切换后重新测试导入、图片、导出、备份和恢复。Cloudflare 不改变 ECS 调用微信的公网出口。

## 14. 故障速查

| 现象 | 检查与处理 |
|---|---|
| 打开 `file://.../index.html` 空白 | 访问部署后的 HTTPS 域名；源码入口不是静态网站成品 |
| 域名连接超时 | DNS A / AAAA、ECS 安全组、主机防火墙、Caddy 监听端口 |
| 证书申请失败 / 浏览器证书错误 | 先 DNS 直连，确认 80 / 443 可达，检查 CAA 和 `docker compose logs caddy`，不要跳过证书验证 |
| 502 | API 是否健康，数据库迁移是否完成，查看 API 日志 |
| 首次迁移连接被拒绝 | 先 `docker compose up -d --wait db redis`；新交付的 ops 服务也会等待数据库健康 |
| 安装凭证错误 | 读取这台服务器上的 `secrets/bootstrap_token`，不要使用本机预览或其他服务器的值 |
| 初始化按钮不再出现 | 已创建管理员，使用登录入口；不要删除用户表重置系统 |
| 登录后 CSRF 错误 | `.env` 的 HTTPS 域名须与浏览器地址完全一致；改配置后重新创建 API / Worker 容器 |
| 公众号白名单错误 | 核实 EIP / SNAT 真正出口，追加微信白名单，保留已有 IP |
| 浏览器服务反复重启 | 看 `docker compose logs browser`；检查内存、user namespace 与 seccomp，保持沙箱开启 |
| Docker 镜像拉取失败 | 检查服务器 DNS / 出站网络和仓库可达性，使用可核验来源；不要临时取消 TLS 校验 |
| 任务一直排队 | 看 `check-deployment.sh --internal-only`、Worker 心跳和 Redis；不要清空业务数据库 |
| 只有图片缺失 | 在详情页重试缺失图片，不必删正文 |

## 15. 上线前最后确认

- HTTPS 地址从你自己的电脑可打开，未登录不能读取文章、图片和 ZIP。
- 管理员、TOTP 和恢复码已保存；运营成员只看到分配的公众号。
- 真实公众号完成官方连接或扫码身份核验，历史清单有核对结果，失败文章和图片有清单。
- 导出包解压后可离线阅读，Markdown 图片使用相对路径。
- 生产凭证已独立保管，每日备份与异机副本已建立。
- 本手册中的 DNS、TLS、真实微信、实际 R2 和异机恢复仍需在你的服务器验收；本次交付不把本机测试算作阿里云生产部署成功。
