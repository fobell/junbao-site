# 凭证说明、生成与保管登记表

这份文件说明需要哪些凭证。**真实生产凭证在你的香港服务器生成，不包含在源码 ZIP 中。** 本机 `localhost` 预览凭证不要复用到生产。

## 1. 服务器自动生成的凭证

在应用目录执行 `bash scripts/deploy.sh` 时，初始化器会生成下表文件；已有文件不会被覆盖。也可以单独运行：

```bash
cd /opt/wechat-archive
docker run --rm --network none -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node scripts/init-secrets.mjs
```

| 文件 | 生成方式 / 用途 | 需要在哪里填写 | 丢失后影响 |
|---|---|---|---|
| `secrets/bootstrap_token` | 随机安装凭证，只用于第一次创建管理员 | 网站“创建管理员”页面 | 初始化后不用于登录 |
| `secrets/database_password` | 随机 PostgreSQL 密码，用户 / 库名均为 `archive` | Docker 自动挂载，无需在网页填写 | 需按数据库密码变更流程修复，不能只改文本文件 |
| `secrets/database_url` | 与上面密码配套，内部主机名为 `db` | Docker 自动挂载 | URL 和数据库实际密码必须一致 |
| `secrets/encryption_key` | 32 字节随机 AES-256-GCM 主密钥，以 64 位十六进制保存 | Docker 自动挂载 | 无法解密原有 AppSecret、浏览器会话和 TOTP 秘密 |
| `secrets/browser_token` | API / Worker 访问内部浏览器服务的随机令牌 | Docker 自动挂载 | 需要协调替换 API、Worker 和浏览器的同一令牌 |
| `secrets/backup_key` | 独立的随机备份加密密钥 | Docker 自动挂载 | 原有 `.wca` 备份将无法解密 |

`browser_token` 与微信公众号后台的开发者 Token 不是同一个东西。本项目不要求修改公众号回调 URL、Token 或 EncodingAESKey。

## 2. 自己设置或从外部取得的凭证

| 项目 | 来源 | 存放 / 输入位置 |
|---|---|---|
| 阿里云控制台账号 | 你的阿里云账户 | 仅在阿里云控制台使用 |
| ECS SSH 用户、私钥或密码 | 你已经持有的服务器登录方式 | SSH 客户端；不写进本项目 `.env` |
| DNS 管理权限 | 域名服务商或 Cloudflare | 只在 DNS 控制台设置解析 |
| 应用管理员用户名 / 密码 | 第一次打开网站时由你自行设置 | 网页登录；没有默认 `admin/admin` 密码 |
| 管理员 TOTP / 恢复码 | 网页初始化验证器时生成 | 私人验证器和私有密码库；一次性恢复码只显示一次 |
| 运营成员初始密码 | 应用管理员创建成员时设置 | 交给对应成员，首次登录修改 |
| 公众号原始 ID、AppID / AppSecret | 你拥有权限的微信公众平台 | 本应用“公众号管理”的官方连接表单；存入数据库时加密 |
| 微信后台扫码会话 | 手机微信登录服务器浏览器后取得 | 自动加密保存；不要求手工复制 Cookie |
| R2 Access Key ID / Secret Access Key | 可选，Cloudflare R2 控制台 | 受保护 `.env` 或 Docker Secret；限定私有桶权限 |

阿里云 AccessKey、微信 AppSecret、R2 Secret Access Key 相互无关。基础 ECS 部署不需要阿里云 AccessKey。没有你的实际账号授权，交付工具无法替你生成微信或云账户凭据。

应用密码只保存哈希，无法导出原始密码。TOTP 恢复码也不能事后查看原文，请在创建时保存。

## 3. 导出这台服务器的实际密钥清单

如果希望保存一份集中凭证文件，在生产服务器执行：

```bash
cd /opt/wechat-archive
docker run --rm --network none -v "$PWD:/work" -w /work node:24.22.2-bookworm-slim node scripts/credential-sheet.mjs --include-secrets
```

文件在 `secrets/credential-sheet.local.json`，包括第 1 节的实际值、生成时间、应用网址和用途说明，权限为 `0600`。密钥不会显示在命令输出中。文件已存在会拒绝覆盖，避免误替换历史清单。

从自己的电脑经 SSH 取回：

```bash
scp -i /路径/你的SSH私钥.pem root@服务器公网IP:/opt/wechat-archive/secrets/credential-sheet.local.json ./wechat-production-credentials.json
chmod 600 ./wechat-production-credentials.json
```

这个 JSON 是明文秘密文件，应进入私有密码库或加密离线备份，不发送到群聊、公开仓库或网站静态目录。源码打包工具和 Git 排除规则会排除整个 `secrets/`。

如凭证发生正式轮换，需要先保留旧版用于旧备份恢复，再重新导出。不要把文件存在错误当作理由直接覆盖未知的旧凭据。

## 4. 权限与恢复注意

- `secrets/` 目录为 `0700`。单个挂载密钥文件为 `0444`，用于容器内非 root 用户只读访问；其他宿主机用户不能穿过私有父目录。
- `.env` 为 `0600`。R2 凭据如果采用环境变量配置，不要输出完整 `docker compose config` 到公开日志；排错时使用 `config --quiet`。
- 恢复已有存档时必须保留原 `encryption_key` 和 `backup_key`；新数据库密码可以重新设，但 URL 必须与实际数据库同步。
- 不要删除密钥文件后再运行初始化器来“重置密码”。密钥文件与已经初始化的数据库存在对应关系。
- 备份 `.wca` 不自动包含主密钥和备份密钥，需要单独安全备份。备份密钥变更后，旧备份仍需要旧密钥。
- 管理员丢失验证器先使用恢复码；两者都丢失时，服务器管理员可用运维手册中的 `reset-totp` 命令，原登录密码仍然有效且需要保管。

## 5. 不含秘密值的交接登记表

可把下面的非秘密信息交给运维同事；实际密码和密钥用密码库单独授权。

| 记录项 | 填写内容 |
|---|---|
| 生产网站地址 | |
| ECS 实例名称 / ID 与地区 | 香港 / |
| 入站公网 IP | |
| 微信请求出口 IP | |
| SSH 用户与私钥保管位置 | 只记录位置，不粘贴私钥 |
| 安装目录 | `/opt/wechat-archive` |
| 管理员用户名 | 不填写密码 |
| 密码库条目名称 | |
| encryption_key / backup_key 的离线保管位置 | |
| 每日备份任务负责人 | |
| 异机备份目的地 | |
| 最近恢复演练日期 | |
| 公众号清单及授权负责人 | |
