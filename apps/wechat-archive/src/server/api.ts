import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { db, one, transaction, audit } from "./db.js";
import { registerAuth, admin, canAccount, accountFilter } from "./auth.js";
import { seal, hash, passwordHash } from "./security.js";
import { createJob, actionJob, createExport } from "./jobs.js";
import { OfficialApiAdapter, browserCall } from "./sources.js";
import { validateUrl } from "./network.js";
import { store } from "./storage.js";
import { AppError } from "../shared/types.js";
import { openApiDocument } from "./openapi.js";
const idOf = (req: any) => z.uuid().parse(req.params.id);
const keyOf = (req: any) =>
  z.string().max(100).optional().parse(req.headers["idempotency-key"]);
export async function buildApp() {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              'req.headers["x-csrf-token"]',
            ],
          },
    trustProxy: process.env.TRUSTED_PROXY_CIDR || false,
    requestTimeout: 120000,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Wechat Archive API", version: "1.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "archive_session" },
          csrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
        },
      },
      security: [{ session: [] }],
    },
  });
  app.addHook("onRoute", (opts) => {
    if (opts.url.startsWith("/api/v1/"))
      opts.schema = {
        tags: [opts.url.split("/")[3]],
        security: [
          "/api/v1/auth/login",
          "/api/v1/bootstrap",
          "/api/v1/bootstrap/status",
        ].includes(opts.url)
          ? []
          : [
              ["GET", "HEAD"].includes(String(opts.method))
                ? { session: [] }
                : { session: [], csrf: [] },
            ],
        ...opts.schema,
      };
  });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (config.production)
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
      );
  });
  app.setErrorHandler((e: any, req, reply) => {
    if (e instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION",
          message: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
          retryable: false,
        },
        requestId: req.id,
      });
    if (e instanceof AppError)
      return reply.code(e.status).send({
        error: { code: e.code, message: e.message, retryable: e.retryable },
        requestId: req.id,
      });
    if (e.code === "23505")
      return reply.code(409).send({
        error: {
          code: "CONFLICT",
          message: "记录已存在或账号已有进行中的任务",
        },
        requestId: req.id,
      });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({
        error: {
          code: "REQUEST_REJECTED",
          message:
            e.statusCode === 429
              ? "操作过于频繁，请稍后再试"
              : "请求格式不正确",
        },
        requestId: req.id,
      });
    req.log.error(
      { code: e.code ?? e.name, requestId: req.id },
      "Request failed",
    );
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "服务暂不可用，请稍后重试" },
      requestId: req.id,
    });
  });
  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  await registerAuth(app);
  app.get("/api/v1/openapi.json", async (req) => {
    admin(req);
    return openApiDocument(app.swagger());
  });
  app.get("/api/v1/overview", async (req) => {
    const f = accountFilter(req, "a");
    const articles = await one(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE resource_state='complete')::int AS complete,count(*) FILTER(WHERE resource_state='missing')::int AS missing FROM articles a WHERE ${f.sql}`,
      f.args,
    );
    const tasks = await one(
      `SELECT count(*)::int AS active FROM jobs a WHERE state IN ('queued','running','cooldown','waiting_auth') AND (${f.sql}${req.user.role !== "admin" ? ` OR (a.account_id IS NULL AND a.user_id=$1)` : ""})`,
      f.args,
    );
    return { ...articles, activeTasks: tasks!.active };
  });
  app.get("/api/v1/accounts", async (req) => ({
    items: (
      await db.query(
        `SELECT a.*,COALESCE((SELECT jsonb_object_agg(c.kind,jsonb_build_object('status',c.status,'error',c.last_error,'checkedAt',c.last_checked_at)) FROM connections c WHERE c.account_id=a.id),'{}') AS connections,(SELECT count(*)::int FROM articles ar WHERE ar.account_id=a.id) AS article_count FROM accounts a ${req.user.role === "admin" ? "" : "WHERE a.id IN (SELECT account_id FROM account_access WHERE user_id=$1)"} ORDER BY a.created_at`,
        req.user.role === "admin" ? [] : [req.user.id],
      )
    ).rows,
  }));
  const accountSchema = z.object({
    name: z.string().min(1).max(80),
    originalId: z.string().regex(/^gh_[a-zA-Z0-9]+$/),
    appId: z
      .string()
      .regex(/^wx[a-zA-Z0-9]+$/)
      .optional(),
    appSecret: z.string().min(16).max(200).optional(),
  });
  app.get("/api/v1/accounts/:id/connections", async (req) => {
    const id = idOf(req);
    await canAccount(req, id);
    return {
      items: (
        await db.query(
          "SELECT kind,status,last_error,last_checked_at FROM connections WHERE account_id=$1",
          [id],
        )
      ).rows,
    };
  });
  app.post(
    "/api/v1/accounts",
    { schema: { body: z.toJSONSchema(accountSchema, { target: "draft-7" }) } },
    async (req, reply) => {
      admin(req);
      const b = accountSchema.parse(req.body);
      if (b.appSecret && !b.appId)
        throw new AppError("APP_ID_REQUIRED", "配置密钥时需要 AppID");
      const a = await transaction(async (c) => {
        const a = (
          await c.query(
            "INSERT INTO accounts(name,original_id,app_id,sync_hour,sync_minute) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              b.name,
              b.originalId,
              b.appId ?? null,
              config.syncHour,
              config.syncMinute,
            ],
          )
        ).rows[0];
        if (b.appSecret)
          await c.query(
            "INSERT INTO connections(account_id,kind,secret) VALUES($1,$2,$3)",
            [
              a.id,
              "official",
              seal({ appSecret: b.appSecret }, `${a.id}:official`),
            ],
          );
        return a;
      });
      await audit(req.user.id, "account.create", a.id);
      return reply.code(201).send(a);
    },
  );
  app.patch("/api/v1/accounts/:id", async (req) => {
    admin(req);
    const id = idOf(req);
    await canAccount(req, id);
    const b = z
      .object({
        name: z.string().min(1).max(80),
        autoSync: z.boolean(),
        syncHour: z.number().int().min(0).max(23),
        syncMinute: z.number().int().min(0).max(59),
      })
      .parse(req.body);
    await db.query(
      "UPDATE accounts SET name=$2,auto_sync=$3,sync_hour=$4,sync_minute=$5 WHERE id=$1",
      [id, b.name, b.autoSync, b.syncHour, b.syncMinute],
    );
    return { ok: true };
  });
  app.put("/api/v1/accounts/:id/connections", async (req) => {
    admin(req);
    const id = idOf(req);
    await canAccount(req, id);
    const b = z
      .object({
        appId: z.string().regex(/^wx[a-zA-Z0-9]+$/),
        appSecret: z.string().min(16).max(200),
      })
      .parse(req.body);
    await transaction(async (c) => {
      await c.query("UPDATE accounts SET app_id=$2 WHERE id=$1", [id, b.appId]);
      await c.query(
        "INSERT INTO connections(account_id,kind,secret) VALUES($1,'official',$2) ON CONFLICT(account_id,kind) DO UPDATE SET secret=EXCLUDED.secret,status='unknown',token_secret=NULL,token_expires_at=NULL,updated_at=now()",
        [id, seal({ appSecret: b.appSecret }, `${id}:official`)],
      );
    });
    await audit(req.user.id, "connection.replace", id);
    return { ok: true };
  });
  app.delete("/api/v1/accounts/:id/connections/:kind", async (req) => {
    admin(req);
    const id = idOf(req);
    await canAccount(req, id);
    const kind = z
      .enum(["official", "browser"])
      .parse((req.params as any).kind);
    const active = (
      await db.query(
        "SELECT id FROM browser_sessions WHERE account_id=$1 AND state NOT IN ('closed','failed','expired')",
        [id],
      )
    ).rows;
    for (const s of active)
      await browserCall(`/sessions/${s.id}/close`, {}).catch(() => {});
    await db.query(
      "UPDATE browser_sessions SET state='closed' WHERE account_id=$1",
      [id],
    );
    await db.query("DELETE FROM connections WHERE account_id=$1 AND kind=$2", [
      id,
      kind,
    ]);
    await audit(req.user.id, "connection.disconnect", id, { kind });
    return { ok: true };
  });
  app.post("/api/v1/accounts/:id/test-connection", async (req) => {
    admin(req);
    const id = idOf(req);
    await canAccount(req, id);
    const a = await one("SELECT * FROM accounts WHERE id=$1", [id]);
    try {
      await new OfficialApiAdapter(a!).probe();
      await db.query(
        "UPDATE connections SET status='connected',last_error=NULL,last_checked_at=now() WHERE account_id=$1 AND kind='official'",
        [id],
      );
      return { ok: true, egressIp: config.egressIp || null };
    } catch (e) {
      await db.query(
        "UPDATE connections SET status='error',last_error=$2,last_checked_at=now() WHERE account_id=$1 AND kind='official'",
        [id, e instanceof AppError ? e.message : "连接失败"],
      );
      throw e;
    }
  });
  app.post("/api/v1/accounts/:id/browser-sessions", async (req, reply) => {
    const id = idOf(req);
    await canAccount(req, id);
    const account = await one("SELECT * FROM accounts WHERE id=$1", [id]);
    const session = (
      await db.query(
        "INSERT INTO browser_sessions(account_id,user_id) VALUES($1,$2) RETURNING id",
        [id, req.user.id],
      )
    ).rows[0];
    try {
      await browserCall("/sessions", { id: session.id, account });
    } catch (e) {
      await db.query(
        "UPDATE browser_sessions SET state='failed',error=$2 WHERE id=$1",
        [session.id, e instanceof AppError ? e.message : "浏览器不可用"],
      );
      throw e;
    }
    await audit(req.user.id, "browser.login.start", id);
    return reply.code(201).send(session);
  });
  async function browserSession(req: any) {
    const id = idOf(req);
    const s = await one(
      "SELECT * FROM browser_sessions WHERE id=$1 AND expires_at>now()",
      [id],
    );
    if (!s) throw new AppError("SESSION_EXPIRED", "扫码会话已过期", 410);
    await canAccount(req, s.account_id);
    if (s.user_id !== req.user.id)
      throw new AppError("FORBIDDEN", "只能操作自己创建的扫码会话", 403);
    return s;
  }
  app.get("/api/v1/browser-sessions/:id", async (req) => {
    const s = await browserSession(req);
    if (s.state === "connected") return { state: "connected" };
    const result = await browserCall(`/sessions/${s.id}`);
    if (result.state === "connected" && result.storageState) {
      await db.query(
        "INSERT INTO connections(account_id,kind,secret,status,last_checked_at) VALUES($1,'browser',$2,'connected',now()) ON CONFLICT(account_id,kind) DO UPDATE SET secret=EXCLUDED.secret,status='connected',last_error=NULL,last_checked_at=now(),updated_at=now()",
        [s.account_id, seal(result.storageState, `${s.account_id}:browser`)],
      );
      await browserCall(`/sessions/${s.id}/close`, {});
      await audit(req.user.id, "browser.login.complete", s.account_id);
    }
    await db.query(
      "UPDATE browser_sessions SET state=$2,error=$3 WHERE id=$1",
      [s.id, result.state, result.error ?? null],
    );
    return { state: result.state, error: result.error };
  });
  app.get("/api/v1/browser-sessions/:id/screen", async (req) => {
    const s = await browserSession(req);
    if (s.state === "connected") return { state: "connected" };
    return browserCall(`/sessions/${s.id}/screen`);
  });
  app.post("/api/v1/browser-sessions/:id/action", async (req) => {
    const s = await browserSession(req);
    return browserCall(`/sessions/${s.id}/action`, req.body);
  });
  app.delete("/api/v1/browser-sessions/:id", async (req) => {
    const s = await browserSession(req);
    await browserCall(`/sessions/${s.id}/close`, {}).catch(() => {});
    await db.query("UPDATE browser_sessions SET state='closed' WHERE id=$1", [
      s.id,
    ]);
    return { ok: true };
  });
  app.post("/api/v1/accounts/:id/sync-jobs", async (req, reply) => {
    const id = idOf(req);
    await canAccount(req, id);
    const b = z
      .object({
        mode: z.enum(["full", "incremental", "reconcile"]).default("full"),
      })
      .parse(req.body ?? {});
    const j = await createJob("sync", id, req.user.id, b, keyOf(req));
    return reply.code(202).send({ jobId: j.id });
  });
  app.post("/api/v1/imports", async (req, reply) => {
    const b = z
      .object({
        accountId: z.uuid(),
        urls: z.array(z.string().max(4096)).min(1).max(1000),
      })
      .parse(req.body);
    await canAccount(req, b.accountId);
    b.urls.forEach((u) => validateUrl(u, "article"));
    const j = await createJob(
      "import",
      b.accountId,
      req.user.id,
      { urls: [...new Set(b.urls)] },
      keyOf(req),
    );
    return reply.code(202).send({ jobId: j.id });
  });
  app.get("/api/v1/articles", async (req) => {
    const q = z
      .object({
        q: z.string().max(200).optional(),
        accountId: z.uuid().optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        tag: z.string().max(40).optional(),
        state: z.enum(["complete", "missing", "pending"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    const f = accountFilter(req, "a");
    const args = f.args;
    const conditions = [f.sql];
    const add = (s: string, v: any) => {
      args.push(v);
      conditions.push(s.replace("?", `$${args.length}`));
    };
    if (q.accountId) add("a.account_id=?", q.accountId);
    if (q.q) {
      args.push(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
      conditions.push(
        `(a.title ILIKE $${args.length} OR v.plain_text ILIKE $${args.length})`,
      );
    }
    if (q.from)
      add(
        "a.published_at >= (?::date::timestamp AT TIME ZONE 'Asia/Shanghai')",
        q.from,
      );
    if (q.to)
      add(
        "a.published_at < ((?::date + interval '1 day') AT TIME ZONE 'Asia/Shanghai')",
        q.to,
      );
    if (q.tag) add("?=ANY(a.tags)", q.tag);
    if (q.state) add("a.resource_state=?", q.state);
    const where = conditions.join(" AND ");
    const count = await one(
      `SELECT count(*)::int AS n FROM articles a LEFT JOIN article_versions v ON v.id=a.current_version_id WHERE ${where}`,
      args,
    );
    const items = (
      await db.query(
        `SELECT a.*,ac.name AS account_name,ac.coverage,LEFT(v.plain_text,160) AS excerpt FROM articles a JOIN accounts ac ON ac.id=a.account_id LEFT JOIN article_versions v ON v.id=a.current_version_id WHERE ${where} ORDER BY a.published_at DESC NULLS LAST,a.id LIMIT 30 OFFSET $${args.length + 1}`,
        [...args, (q.page - 1) * 30],
      )
    ).rows;
    return { items, total: count!.n, page: q.page, pageSize: 30 };
  });
  async function article(req: any) {
    const a = await one("SELECT * FROM articles WHERE id=$1", [idOf(req)]);
    if (!a) throw new AppError("NOT_FOUND", "文章不存在", 404);
    await canAccount(req, a.account_id);
    return a;
  }
  app.get("/api/v1/articles/:id", async (req) => {
    const a = await article(req);
    const versionId = z
      .uuid()
      .optional()
      .parse((req.query as any).version);
    const v = await one(
      "SELECT id,preview_html,markdown,metadata,warnings,archived_at FROM article_versions WHERE article_id=$1 AND id=$2",
      [a.id, versionId ?? a.current_version_id],
    );
    const images = v
      ? (
          await db.query(
            "SELECT source_url,state,error FROM article_assets WHERE version_id=$1",
            [v.id],
          )
        ).rows
      : [];
    const versions = (
      await db.query(
        "SELECT id,archived_at FROM article_versions WHERE article_id=$1 ORDER BY archived_at DESC",
        [a.id],
      )
    ).rows;
    return { ...a, version: v, images, versions };
  });
  app.patch("/api/v1/articles/:id/tags", async (req) => {
    const a = await article(req);
    const b = z
      .object({ tags: z.array(z.string().min(1).max(40)).max(20) })
      .parse(req.body);
    await db.query("UPDATE articles SET tags=$2 WHERE id=$1", [
      a.id,
      [...new Set(b.tags)],
    ]);
    return { ok: true };
  });
  app.post("/api/v1/articles/:id/repair", async (req, reply) => {
    const a = await article(req);
    const b = z
      .object({ refetch: z.boolean().default(false) })
      .parse(req.body ?? {});
    const j = await createJob(
      "repair",
      a.account_id,
      req.user.id,
      { articleId: a.id, ...b },
      keyOf(req),
    );
    return reply.code(202).send({ jobId: j.id });
  });
  app.get("/api/v1/assets/:id", async (req, reply) => {
    const a = await one("SELECT * FROM assets WHERE id=$1", [idOf(req)]);
    if (!a) throw new AppError("NOT_FOUND", "图片不存在", 404);
    await canAccount(req, a.account_id);
    return reply
      .type(a.mime)
      .header("Cache-Control", "private, max-age=3600")
      .send(await store.get(a.storage_key));
  });
  app.get("/api/v1/jobs", async (req) => {
    const f = accountFilter(req, "j");
    return {
      items: (
        await db.query(
          `SELECT j.id,j.account_id,j.kind,j.state,j.phase,j.discovered,j.processed,j.failed,j.error,j.report,j.next_run_at,j.created_at,j.updated_at,a.name AS account_name FROM jobs j LEFT JOIN accounts a ON a.id=j.account_id WHERE (${f.sql}${req.user.role !== "admin" ? " OR (j.account_id IS NULL AND j.user_id=$1)" : ""}) ORDER BY j.created_at DESC LIMIT 100`,
          f.args,
        )
      ).rows,
    };
  });
  async function jobAccess(req: any) {
    const j = await one("SELECT * FROM jobs WHERE id=$1", [idOf(req)]);
    if (!j) throw new AppError("NOT_FOUND", "任务不存在", 404);
    if (j.account_id) await canAccount(req, j.account_id);
    else if (j.user_id !== req.user.id && req.user.role !== "admin")
      throw new AppError("FORBIDDEN", "无权访问此任务", 403);
    return j;
  }
  app.get("/api/v1/jobs/:id", async (req) => {
    const j = await jobAccess(req);
    const errors = (
      await db.query(
        "SELECT item_key,error FROM job_items WHERE job_id=$1 AND state='failed' LIMIT 100",
        [j.id],
      )
    ).rows;
    delete j.payload;
    delete j.checkpoint;
    return { ...j, errors };
  });
  app.post("/api/v1/jobs/:id/actions", async (req) => {
    const j = await jobAccess(req);
    const b = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(req.body);
    await audit(req.user.id, `job.${b.action}`, j.id);
    return actionJob(j.id, b.action);
  });
  app.post("/api/v1/exports", async (req, reply) => {
    const b = z
      .object({ articleIds: z.array(z.uuid()).min(1).max(1000) })
      .parse(req.body);
    const j = await createExport(
      req.user,
      [...new Set(b.articleIds)],
      keyOf(req),
    );
    await audit(req.user.id, "export.create", j.id);
    return reply.code(202).send({ jobId: j.id });
  });
  app.get("/api/v1/exports", async (req) => ({
    items: (
      await db.query(
        `SELECT e.*,j.state AS job_state,j.error FROM exports e JOIN jobs j ON j.id=e.job_id ${req.user.role === "admin" ? "" : "WHERE e.user_id=$1 AND NOT EXISTS (SELECT 1 FROM export_items ei WHERE ei.export_id=e.id AND NOT EXISTS (SELECT 1 FROM account_access aa WHERE aa.account_id=ei.account_id AND aa.user_id=$1))"} ORDER BY e.created_at DESC LIMIT 100`,
        req.user.role === "admin" ? [] : [req.user.id],
      )
    ).rows,
  }));
  app.get("/api/v1/exports/:id/download", async (req, reply) => {
    const e = await one("SELECT * FROM exports WHERE id=$1", [idOf(req)]);
    if (!e) throw new AppError("NOT_FOUND", "导出不存在", 404);
    if (e.user_id !== req.user.id && req.user.role !== "admin")
      throw new AppError("FORBIDDEN", "无权下载", 403);
    const accounts = (
      await db.query(
        "SELECT DISTINCT account_id FROM export_items WHERE export_id=$1",
        [e.id],
      )
    ).rows;
    for (const a of accounts) await canAccount(req, a.account_id);
    if (
      e.state !== "ready" ||
      !e.storage_key ||
      new Date(e.expires_at).getTime() < Date.now()
    )
      throw new AppError(
        "EXPORT_EXPIRED",
        "下载包尚未生成或已过期，请重新导出",
        410,
      );
    await audit(req.user.id, "export.download", e.id);
    return reply
      .type("application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="wechat-archive-${e.id.slice(0, 8)}.zip"`,
      )
      .send(await store.get(e.storage_key));
  });
  app.get("/api/v1/settings", async (req) => {
    admin(req);
    const fs = await statfs(config.dataDir).catch(() => null);
    const statuses = (await db.query("SELECT * FROM system_status")).rows;
    return {
      storageDriver: config.storageDriver,
      egressIp: config.egressIp || null,
      origin: config.origin,
      diskFree: fs ? fs.bavail * fs.bsize : null,
      defaults: { syncHour: config.syncHour, syncMinute: config.syncMinute },
      statuses,
    };
  });
  app.get("/api/v1/users", async (req) => {
    admin(req);
    return {
      items: (
        await db.query(
          "SELECT u.id,u.username,u.display_name,u.role,u.active,u.totp_enabled,COALESCE((SELECT jsonb_agg(account_id) FROM account_access WHERE user_id=u.id),'[]') AS account_ids FROM users u ORDER BY created_at",
        )
      ).rows,
    };
  });
  app.post("/api/v1/users", async (req, reply) => {
    admin(req);
    const b = z
      .object({
        username: z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),
        displayName: z.string().min(1).max(60),
        password: z.string().min(12).max(256),
        accountIds: z.array(z.uuid()),
      })
      .parse(req.body);
    const ph = await passwordHash(b.password);
    const u = await transaction(async (c) => {
      const u = (
        await c.query(
          "INSERT INTO users(username,display_name,password_hash,role,must_change_password) VALUES($1,$2,$3,'operator',true) RETURNING id",
          [b.username, b.displayName, ph],
        )
      ).rows[0];
      for (const id of new Set(b.accountIds))
        await c.query(
          "INSERT INTO account_access(user_id,account_id) VALUES($1,$2)",
          [u.id, id],
        );
      return u;
    });
    await audit(req.user.id, "user.create", u.id);
    return reply.code(201).send(u);
  });
  app.put("/api/v1/users/:id", async (req) => {
    admin(req);
    const id = idOf(req);
    if (id === req.user.id)
      throw new AppError("SELF_CHANGE", "不能在此停用自己", 400);
    const b = z
      .object({ active: z.boolean(), accountIds: z.array(z.uuid()) })
      .parse(req.body);
    await transaction(async (c) => {
      await c.query("UPDATE users SET active=$2 WHERE id=$1", [id, b.active]);
      await c.query("DELETE FROM account_access WHERE user_id=$1", [id]);
      for (const accountId of new Set(b.accountIds))
        await c.query(
          "INSERT INTO account_access(user_id,account_id) VALUES($1,$2)",
          [id, accountId],
        );
      await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    });
    await audit(req.user.id, "user.permissions", id);
    return { ok: true };
  });
  const web = resolve("dist/web");
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在" } })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
