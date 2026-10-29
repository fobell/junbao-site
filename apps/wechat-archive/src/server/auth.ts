import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { db, one, transaction, audit, type Row } from "./db.js";
import { config } from "./config.js";
import {
  hash,
  randomToken,
  passwordHash,
  checkPassword,
  equal,
  seal,
  unseal,
  newTotpSecret,
  verifyTotp,
} from "./security.js";
import { AppError } from "../shared/types.js";
declare module "fastify" {
  interface FastifyRequest {
    user: Row;
    session: Row;
  }
}
export async function canAccount(req: FastifyRequest, id: string) {
  z.uuid().parse(id);
  if (req.user.role === "admin") {
    if (!(await one("SELECT id FROM accounts WHERE id=$1", [id])))
      throw new AppError("NOT_FOUND", "公众号不存在", 404);
    return;
  }
  if (
    !(await one(
      "SELECT 1 FROM account_access WHERE user_id=$1 AND account_id=$2",
      [req.user.id, id],
    ))
  )
    throw new AppError("FORBIDDEN", "无权访问此公众号", 403);
}
export function admin(req: FastifyRequest) {
  if (req.user.role !== "admin")
    throw new AppError("FORBIDDEN", "仅管理员可执行此操作", 403);
}
export function accountFilter(req: FastifyRequest, alias = "a", position = 1) {
  return req.user.role === "admin"
    ? { sql: "TRUE", args: [] as any[] }
    : {
        sql: `${alias}.account_id IN (SELECT account_id FROM account_access WHERE user_id=$${position})`,
        args: [req.user.id],
      };
}
async function sessionFor(reply: any, userId: string) {
  const token = randomToken(),
    csrf = randomToken();
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
    [hash(token), userId, csrf],
  );
  reply.setCookie("archive_session", token, {
    path: "/",
    httpOnly: true,
    secure: config.production,
    sameSite: "strict",
    maxAge: 43200,
  });
  return csrf;
}
export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest("user");
  app.decorateRequest("session");
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      throw new AppError("CSRF", "请求来源不匹配", 403);
    const path = req.url.split("?")[0];
    if (
      [
        "/api/v1/auth/login",
        "/api/v1/bootstrap",
        "/api/v1/bootstrap/status",
      ].includes(path)
    )
      return;
    const token = req.cookies.archive_session;
    const session = token
      ? await one(
          "SELECT s.*,u.username,u.display_name,u.role,u.active,u.totp_enabled,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now() AND s.last_seen>now()-interval '2 hours'",
          [hash(token)],
        )
      : undefined;
    if (!session || !session.active)
      throw new AppError("UNAUTHENTICATED", "请先登录", 401);
    req.user = {
      id: session.user_id,
      username: session.username,
      display_name: session.display_name,
      role: session.role,
      totp_enabled: session.totp_enabled,
      must_change_password: session.must_change_password,
    };
    req.session = session;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf)
    )
      throw new AppError("CSRF", "会话校验失败，请刷新页面", 403);
    if (
      !path.startsWith("/api/v1/auth/") &&
      (req.user.must_change_password ||
        (req.user.role === "admin" && !req.user.totp_enabled))
    )
      throw new AppError("SETUP_REQUIRED", "请先完成密码与验证器设置", 403);
    if (Date.now() - new Date(session.last_seen).getTime() > 60000)
      await db.query("UPDATE sessions SET last_seen=now() WHERE id_hash=$1", [
        session.id_hash,
      ]);
  });
  app.get("/api/v1/bootstrap/status", async () => ({
    required: !(await one("SELECT id FROM users LIMIT 1")),
  }));
  app.post(
    "/api/v1/bootstrap",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const b = z
        .object({
          token: z.string(),
          username: z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/),
          password: z.string().min(12).max(256),
          displayName: z.string().min(1).max(60),
        })
        .parse(req.body);
      if (!config.bootstrapToken || !equal(b.token, config.bootstrapToken))
        throw new AppError(
          "BOOTSTRAP_DENIED",
          "安装凭证错误或安装入口未启用",
          403,
        );
      const ph = await passwordHash(b.password);
      const user = await transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(40001)");
        if (await one("SELECT id FROM users LIMIT 1", [], c))
          throw new AppError("ALREADY_INITIALIZED", "系统已经初始化", 409);
        return (
          await c.query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id",
            [b.username, b.displayName, ph, "admin"],
          )
        ).rows[0];
      });
      return { csrf: await sessionFor(reply, user.id) };
    },
  );
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const b = z
        .object({
          username: z.string().max(80),
          password: z.string().max(256),
          code: z.string().max(100).optional(),
        })
        .parse(req.body);
      const user = await one("SELECT * FROM users WHERE username=$1", [
        b.username,
      ]);
      if (
        !user?.active ||
        !(await checkPassword(b.password, user.password_hash))
      )
        throw new AppError("LOGIN_FAILED", "用户名或密码不正确", 401);
      if (user.totp_enabled) {
        if (!b.code)
          throw new AppError("TOTP_REQUIRED", "请输入验证器验证码", 401);
        await transaction(async (c) => {
          const u = (
            await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
              user.id,
            ])
          ).rows[0];
          const step = verifyTotp(
            unseal<string>(u.totp_secret, `totp:${u.id}`),
            b.code!,
            Number(u.last_totp_step),
          );
          if (step !== null)
            await c.query("UPDATE users SET last_totp_step=$2 WHERE id=$1", [
              u.id,
              step,
            ]);
          else {
            const recovery = hash(b.code!);
            if (!u.recovery_hashes.includes(recovery))
              throw new AppError(
                "TOTP_INVALID",
                "验证码错误、已使用或已过期",
                401,
              );
            await c.query("UPDATE users SET recovery_hashes=$2 WHERE id=$1", [
              u.id,
              JSON.stringify(
                u.recovery_hashes.filter((x: string) => x !== recovery),
              ),
            ]);
          }
        });
      }
      await audit(user.id, "login", user.id);
      return { csrf: await sessionFor(reply, user.id) };
    },
  );
  app.get("/api/v1/auth/me", async (req) => ({
    user: req.user,
    csrf: req.session.csrf,
  }));
  app.post("/api/v1/auth/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [
      req.session.id_hash,
    ]);
    reply.clearCookie("archive_session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/v1/auth/password", async (req) => {
    const b = z
      .object({ current: z.string(), password: z.string().min(12).max(256) })
      .parse(req.body);
    const u = await one("SELECT password_hash FROM users WHERE id=$1", [
      req.user.id,
    ]);
    if (!(await checkPassword(b.current, u!.password_hash)))
      throw new AppError("LOGIN_FAILED", "当前密码不正确", 403);
    await db.query(
      "UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1",
      [req.user.id, await passwordHash(b.password)],
    );
    await db.query("DELETE FROM sessions WHERE user_id=$1 AND id_hash<>$2", [
      req.user.id,
      req.session.id_hash,
    ]);
    return { ok: true };
  });
  app.post("/api/v1/auth/totp/setup", async (req) => {
    const u = await one("SELECT totp_enabled FROM users WHERE id=$1", [
      req.user.id,
    ]);
    if (u!.totp_enabled)
      throw new AppError("TOTP_ENABLED", "验证器已启用", 409);
    const secret = newTotpSecret();
    await db.query("UPDATE users SET totp_secret=$2 WHERE id=$1", [
      req.user.id,
      seal(secret, `totp:${req.user.id}`),
    ]);
    const uri = `otpauth://totp/WechatArchive:${encodeURIComponent(req.user.username)}?secret=${secret}&issuer=WechatArchive`;
    return { secret, qr: await QRCode.toDataURL(uri) };
  });
  app.post("/api/v1/auth/totp/verify", async (req) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    return transaction(async (c) => {
      const u = (
        await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
          req.user.id,
        ])
      ).rows[0];
      if (u.totp_enabled || !u.totp_secret)
        throw new AppError("TOTP_SETUP", "请先生成验证器密钥", 409);
      const step = verifyTotp(
        unseal<string>(u.totp_secret, `totp:${u.id}`),
        code,
      );
      if (step === null)
        throw new AppError("TOTP_INVALID", "验证码不正确", 400);
      const codes = Array.from({ length: 8 }, () => randomToken().slice(0, 16));
      await c.query(
        "UPDATE users SET totp_enabled=true,last_totp_step=$2,recovery_hashes=$3 WHERE id=$1",
        [u.id, step, JSON.stringify(codes.map(hash))],
      );
      return { recoveryCodes: codes };
    });
  });
}
