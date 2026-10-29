type Schema = Record<string, any>;
const text = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const uuid = text({ format: "uuid" });
const bool = { type: "boolean" };
const array = (items: Schema, extra: Schema = {}): Schema => ({
  type: "array",
  items,
  ...extra,
});
const object = (
  properties: Schema,
  required = Object.keys(properties),
): Schema => ({ type: "object", properties, required });
const choice = (...values: string[]) => text({ enum: values });
const password = text({ minLength: 12, maxLength: 256, writeOnly: true });
const username = text({ pattern: "^[a-zA-Z0-9_-]{3,40}$" });
const appId = text({ pattern: "^wx[a-zA-Z0-9]+$" });
const appSecret = text({ minLength: 16, maxLength: 200, writeOnly: true });
const displayName = text({ minLength: 1, maxLength: 60 });
const bodies: Record<string, Schema> = {
  "POST /bootstrap": object({
    token: text({ writeOnly: true }),
    username,
    displayName,
    password,
  }),
  "POST /auth/login": object(
    {
      username: text({ maxLength: 80 }),
      password: text({ maxLength: 256, writeOnly: true }),
      code: text({ maxLength: 100, writeOnly: true }),
    },
    ["username", "password"],
  ),
  "POST /auth/password": object({
    current: text({ writeOnly: true }),
    password,
  }),
  "POST /auth/totp/verify": object({ code: text({ writeOnly: true }) }),
  "POST /accounts": object(
    {
      name: text({ minLength: 1, maxLength: 80 }),
      originalId: text({ pattern: "^gh_[a-zA-Z0-9]+$" }),
      appId,
      appSecret,
    },
    ["name", "originalId"],
  ),
  "PATCH /accounts/{id}": object({
    name: text({ minLength: 1, maxLength: 80 }),
    autoSync: bool,
    syncHour: { type: "integer", minimum: 0, maximum: 23 },
    syncMinute: { type: "integer", minimum: 0, maximum: 59 },
  }),
  "PUT /accounts/{id}/connections": object({ appId, appSecret }),
  "POST /accounts/{id}/sync-jobs": object(
    {
      mode: { ...choice("full", "incremental", "reconcile"), default: "full" },
    },
    [],
  ),
  "POST /imports": object({
    accountId: uuid,
    urls: array(
      text({
        maxLength: 4096,
        description: "本账号 mp.weixin.qq.com 的 HTTPS 文章链接",
      }),
      { minItems: 1, maxItems: 1000 },
    ),
  }),
  "POST /browser-sessions/{id}/action": {
    oneOf: [
      object({
        type: choice("click"),
        x: { type: "number", minimum: 0, maximum: 1180 },
        y: { type: "number", minimum: 0, maximum: 800 },
      }),
      object({ type: choice("text"), text: text({ maxLength: 200 }) }),
      object({
        type: choice("key"),
        key: choice("Enter", "Tab", "Backspace", "Escape"),
      }),
    ],
  },
  "PATCH /articles/{id}/tags": object({
    tags: array(text({ minLength: 1, maxLength: 40 }), { maxItems: 20 }),
  }),
  "POST /articles/{id}/repair": object(
    { refetch: { ...bool, default: false } },
    [],
  ),
  "POST /jobs/{id}/actions": object({
    action: choice("pause", "resume", "cancel", "retry"),
  }),
  "POST /exports": object({
    articleIds: array(uuid, { minItems: 1, maxItems: 1000 }),
  }),
  "POST /users": object({
    username,
    displayName,
    password,
    accountIds: array(uuid),
  }),
  "PUT /users/{id}": object({ active: bool, accountIds: array(uuid) }),
};
const summaries: Record<string, string> = {
  "GET /bootstrap/status": "首次初始化状态",
  "POST /bootstrap": "用一次性安装凭证创建管理员",
  "POST /auth/login": "密码与 TOTP 或恢复码登录",
  "GET /auth/me": "当前用户和 CSRF token",
  "POST /auth/logout": "注销当前会话",
  "POST /auth/password": "更改密码并注销其他会话",
  "POST /auth/totp/setup": "创建验证器密钥和二维码",
  "POST /auth/totp/verify": "启用 TOTP 并返回一次性恢复码",
  "GET /openapi.json": "管理员读取 API 描述",
  "GET /overview": "有权访问的文章与任务概览",
  "GET /accounts": "列出有权访问的公众号",
  "POST /accounts": "管理员添加公众号",
  "PATCH /accounts/{id}": "管理员修改账号和同步时间",
  "GET /accounts/{id}/connections": "读取脱敏连接状态",
  "PUT /accounts/{id}/connections": "管理员保存官方凭据",
  "DELETE /accounts/{id}/connections/{kind}": "断开连接并保留存档",
  "POST /accounts/{id}/test-connection": "测试官方文章列表权限",
  "POST /accounts/{id}/browser-sessions": "创建服务器扫码会话",
  "GET /browser-sessions/{id}": "读取扫码状态并保存已验证会话",
  "GET /browser-sessions/{id}/screen": "取得 JSON 中的 Base64 JPEG 登录画面",
  "POST /browser-sessions/{id}/action": "在当前用户的扫码画面中交互",
  "DELETE /browser-sessions/{id}": "关闭扫码会话",
  "POST /accounts/{id}/sync-jobs": "创建全量、增量或历史核对任务",
  "POST /imports": "导入本账号文章链接",
  "GET /articles": "按标题、正文、日期、标签与账号搜索",
  "GET /articles/{id}": "读取正文、版本和图片状态",
  "PATCH /articles/{id}/tags": "更新标签",
  "POST /articles/{id}/repair": "重试缺图或重新获取正文",
  "GET /assets/{id}": "按账号权限读取图片",
  "GET /jobs": "读取最近 100 个可访问任务",
  "GET /jobs/{id}": "任务进度、报告和最多 100 条逐篇错误",
  "POST /jobs/{id}/actions": "暂停、继续、取消或重试任务",
  "POST /exports": "固定版本并异步生成 ZIP",
  "GET /exports": "读取可访问的导出记录",
  "GET /exports/{id}/download": "重新核验权限并下载 ZIP",
  "GET /settings": "管理员查看存储、容量和服务状态",
  "GET /users": "管理员查看成员与授权账号",
  "POST /users": "管理员创建运营成员",
  "PUT /users/{id}": "修改成员授权并回收现有会话",
};
const asyncOperations = new Set([
  "POST /accounts/{id}/sync-jobs",
  "POST /imports",
  "POST /articles/{id}/repair",
  "POST /exports",
]);
const createdOperations = new Set([
  "POST /accounts",
  "POST /accounts/{id}/browser-sessions",
  "POST /users",
]);
const json = (schema: Schema) => ({ "application/json": { schema } });
/** Enrich route-generated documentation only; Zod remains the runtime validator. */
export function openApiDocument(input: any) {
  const doc = structuredClone(input);
  doc.info.description =
    "内部团队私有归档 API。Cookie 会话；修改请求要求同域 Origin 和 X-CSRF-Token。管理员需启用 TOTP，临时密码用户需先改密码。";
  doc.components.schemas = {
    ...doc.components.schemas,
    AcceptedJob: object({ jobId: uuid }),
    ApiError: object({
      error: object({ code: text(), message: text(), retryable: bool }, [
        "code",
        "message",
      ]),
      requestId: text(),
    }),
    JobState: choice(
      "queued",
      "running",
      "paused",
      "waiting_auth",
      "cooldown",
      "succeeded",
      "partial",
      "failed",
      "cancelled",
    ),
  };
  for (const [path, methods] of Object.entries(doc.paths) as [
    string,
    Record<string, any>,
  ][]) {
    if (!path.startsWith("/api/v1/")) {
      if (path === "/healthz") methods.get.security = [];
      continue;
    }
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const key = `${method.toUpperCase()} ${path.slice(7)}`;
      op.summary = summaries[key] ?? key;
      op.operationId = `${method}_${path.slice(8).replace(/[^a-zA-Z0-9]+/g, "_")}`;
      op.parameters ??= [];
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
        const parameter = {
          name,
          in: "path",
          required: true,
          schema: name === "id" ? uuid : choice("official", "browser"),
        };
        const index = op.parameters.findIndex(
          (p: any) => p.in === "path" && p.name === name,
        );
        if (index >= 0) op.parameters[index] = parameter;
        else op.parameters.push(parameter);
      }
      if (bodies[key])
        op.requestBody = {
          required: ![
            "POST /accounts/{id}/sync-jobs",
            "POST /articles/{id}/repair",
          ].includes(key),
          content: json(bodies[key]),
        };
      if (asyncOperations.has(key)) {
        op.parameters.push({
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: text({ maxLength: 100 }),
          description: "同一用户重复提交同一键返回已有任务",
        });
        op.responses = {
          "202": {
            description: "任务已持久化并等待调度",
            content: json({ $ref: "#/components/schemas/AcceptedJob" }),
          },
        };
      } else if (createdOperations.has(key))
        op.responses = {
          "201": {
            description: "资源已创建",
            content: json({ type: "object", additionalProperties: true }),
          },
        };
      else
        op.responses = {
          "200": {
            description: "执行成功；字段语义见 docs/api.md",
            content: json({ type: "object", additionalProperties: true }),
          },
        };
      for (const [status, description] of Object.entries({
        400: "输入不符合约定",
        401: "未登录或验证码无效",
        403: "权限或 CSRF 校验失败",
        404: "记录不存在",
        409: "状态冲突或需要人工处理",
        410: "会话或下载包已过期",
        429: "请求频率受限",
        500: "内部服务错误",
      })) {
        op.responses[status] = {
          description,
          content: json({ $ref: "#/components/schemas/ApiError" }),
        };
      }
      if (method === "get" && path === "/api/v1/articles") {
        const query: Record<string, Schema> = {
          q: text({ maxLength: 200 }),
          accountId: uuid,
          from: text({ format: "date" }),
          to: text({ format: "date" }),
          tag: text({ maxLength: 40 }),
          state: choice("complete", "missing", "pending"),
          page: { type: "integer", minimum: 1, default: 1 },
        };
        op.parameters.push(
          ...Object.entries(query).map(([name, schema]) => ({
            name,
            in: "query",
            required: false,
            schema,
          })),
        );
      }
      if (key === "GET /articles/{id}")
        op.parameters.push({
          name: "version",
          in: "query",
          required: false,
          schema: uuid,
        });
      if (["GET /assets/{id}", "GET /exports/{id}/download"].includes(key))
        op.responses["200"].content = {
          [key.includes("exports") ? "application/zip" : "image/*"]: {
            schema: text({ format: "binary" }),
          },
        };
    }
  }
  return doc;
}
