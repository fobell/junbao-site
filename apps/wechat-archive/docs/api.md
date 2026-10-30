# API 使用约定

独立部署基址 `/api/v1`；tools.junbao.ai 的公开基址为 `/wechat-article-archive/api/v1`。动态 OpenAPI 的 `servers` 包含当前域名与基础路径。下表为相对基址的路径。同域 Cookie 会话。除安装和登录外均要求登录；管理员必须先设置 TOTP，临时密码用户必须先改密码。GET `/auth/me` 返回用户与 `csrf`，修改请求携带 `X-CSRF-Token`，`Origin` 必须与 `APP_ORIGIN` 精确匹配。公开注册关闭。

失败统一 `{ "error": { "code": "…", "message": "…", "retryable": false }, "requestId": "…" }`，未授权 401、无权限 403、状态冲突 409。耗时任务返回 202 `{ "jobId": "uuid" }`，任务创建可带 `Idempotency-Key`（最长 100 字符）；相同用户同一键返回已有任务。

| 方法与路径 | 请求 / 用途 |
|---|---|
| GET `/bootstrap/status` | 是否需要首次初始化 |
| POST `/bootstrap` | `token, username, displayName, password`；只能成功一次 |
| POST `/auth/login` | `username, password, code?`；code 为 TOTP / 一次性恢复码 |
| GET `/auth/me` | 当前用户和 CSRF token |
| POST `/auth/logout` | 注销当前会话 |
| POST `/auth/password` | `current, password`；注销其他会话 |
| POST `/auth/totp/setup` | 返回验证器二维码与密钥；不记录到日志 |
| POST `/auth/totp/verify` | `code`；首次启用时返回 8 个一次性恢复码 |
| GET / POST `/accounts` | 列出有权访问账号；管理员添加 `name, originalId, appId?, appSecret?` |
| PATCH `/accounts/:id` | 管理员保存 `name, autoSync, syncHour, syncMinute` |
| GET `/accounts/:id/connections` | 返回脱敏后的官方与浏览器连接状态，不返回凭据 |
| PUT `/accounts/:id/connections` | 管理员保存 `appId, appSecret`；不会返回密钥 |
| DELETE `/accounts/:id/connections/:kind` | 断开 official / browser，保留存档 |
| POST `/accounts/:id/test-connection` | 管理员测试官方列表权限 |
| POST `/accounts/:id/browser-sessions` | 创建 10 分钟服务器扫码会话 |
| GET `/browser-sessions/:id` | 轮询登录状态，身份匹配后加密保存凭据 |
| GET `/browser-sessions/:id/screen` | 获准且创建该会话的用户获取 JSON：`state, image`（Base64 JPEG）、`width, height`；非交互状态只返回状态 |
| POST `/browser-sessions/:id/action` | `{type:'click',x,y}`、`{type:'text',text}` 或 `{type:'key',key}`；登录结束后拒绝 |
| DELETE `/browser-sessions/:id` | 关闭远程交互 |
| POST `/accounts/:id/sync-jobs` | `mode: full / incremental / reconcile` |
| POST `/imports` | `accountId, urls[]`，最多 1,000 条；正文获取时校验归属 |
| GET `/articles` | `q, accountId, from, to, tag, state, page`；每页 30 条 |
| GET `/articles/:id` | 可选 `version` UUID，返回安全预览 / Markdown / 图片状态 / 版本列表 |
| PATCH `/articles/:id/tags` | `tags[]`，最多 20 个，每个不超过 40 字 |
| POST `/articles/:id/repair` | `refetch:false` 仅重试缺图；true 重抓正文 |
| GET `/assets/:id` | 按所属账号鉴权后读取图片 |
| GET `/jobs` / `/jobs/:id` | 任务列表 / 进度与逐篇错误 |
| POST `/jobs/:id/actions` | `action: pause / resume / cancel / retry` |
| POST `/exports` | `articleIds[]`，最多 1,000 篇且预计不超过 2GiB |
| GET `/exports` | 有权读取的导出记录；权限回收后不泄漏快照 |
| GET `/exports/:id/download` | 再次核验所有涉及账号的访问权，返回 ZIP |
| GET `/settings` | 管理员查看存储 / IP / 容量 / 服务状态 |
| GET / POST `/users` | 管理员读取成员 / 创建运营成员 `username, displayName, password, accountIds[]` |
| PUT `/users/:id` | `active, accountIds[]`，回收会话；不能停用自己 |

GET `/openapi.json` 为管理员鉴权后的动态 OpenAPI 描述，包含请求字段、查询 / 路径参数、幂等键、任务 202 返回及错误结构。`node --import tsx scripts/openapi.ts` 可重新生成仓库中的 `docs/openapi.json`。复杂资源响应保留开放对象定义，字段语义见上表和实现；运行时仍由 Zod 校验输入。
