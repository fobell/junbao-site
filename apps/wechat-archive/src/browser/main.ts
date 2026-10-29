import Fastify from "fastify";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "../server/config.js";
import { equal } from "../server/security.js";
import { AppError } from "../shared/types.js";
import { identityMatches, parsePublishResponse } from "./parser.js";
import { canonicalArticle } from "../server/network.js";
import { z } from "zod";
import { CapacityGate, boundedContext } from "./capacity.js";
const api = Fastify({
  logger: { redact: ["req.headers.authorization"] },
  bodyLimit: 4 * 1024 * 1024,
});
if (config.browserToken.length < 32)
  throw new Error("BROWSER_SERVICE_TOKEN is required");
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: process.env.CHROMIUM_SANDBOX !== "false",
  proxy: { server: config.browserProxy },
  args: [
    "--disable-dev-shm-usage",
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
  ],
});
const contextGate = new CapacityGate(config.browserMaxContexts);
const sessionGate = new CapacityGate(config.browserMaxSessions);
const creatingSessions = new Map<string, Promise<{ id: string }>>();
let shuttingDown = false;
const cancelledSessions = new Set<string>();
browser.on("disconnected", () => {
  if (shuttingDown) return;
  console.error("Browser disconnected; restarting service");
  process.exit(1);
});
type Session = {
  context: BrowserContext;
  page: Page;
  account: any;
  created: number;
  state: string;
  error?: string;
};
const sessions = new Map<string, Session>();
let scanning = false;
let activeScan:
  | { id?: string; context?: BrowserContext; cancelled: boolean }
  | undefined;
api.addHook("onRequest", async (req) => {
  if (!equal(req.headers.authorization ?? "", `Bearer ${config.browserToken}`))
    throw new AppError("UNAUTHORIZED", "拒绝访问", 401);
});
api.setErrorHandler((e: any, _req, reply) => {
  reply.code(e.status ?? 500).send({
    code: e.code || "BROWSER_ERROR",
    message: e instanceof AppError ? e.message : "浏览器操作失败，请重新连接",
  });
});
async function identify(page: Page) {
  await page
    .waitForFunction(
      () => {
        const d = (window as any).wx?.data;
        return !!(d?.user_name || d?.username || d?.appid || d?.app_id);
      },
      {},
      { timeout: 5000 },
    )
    .catch(() => {});
  const info = await page.evaluate(() => {
    const w = window as any;
    const d = w.wx?.data ?? {};
    const text = document.body?.innerText ?? "";
    return {
      originalId:
        d.user_name || d.username || text.match(/gh_[a-zA-Z0-9]+/)?.[0],
      appId: d.appid || d.app_id,
      nickname: d.nick_name || d.nickname,
    };
  });
  return info;
}
async function contextFor(state?: any) {
  return boundedContext(contextGate, () => browser.newContext({
    viewport: { width: 1180, height: 800 },
    locale: "zh-CN",
    storageState: state,
    acceptDownloads: false,
    serviceWorkers: "block",
  }));
}
async function inspect(s: Session) {
  if (Date.now() - s.created > 600000) {
    s.state = "expired";
    await s.context.close().catch(() => {});
    return;
  }
  if (s.state === "connected" || s.state === "failed") return;
  if (new URL(s.page.url()).searchParams.has("token")) {
    const id = await identify(s.page);
    if (identityMatches(s.account, id)) s.state = "connected";
    else if (id.originalId || id.appId) {
      s.state = "failed";
      s.error = "登录的公众号与目标账号不一致";
      await s.context.close();
    } else {
      s.state = "failed";
      s.error =
        "已登录但无法确认公众号身份，交互已关闭。请检查账号标识或更新后台适配器。";
      await s.context.close();
    }
  } else s.state = "waiting_scan";
}
api.post("/sessions", async (req) => {
  const body = z
    .object({
      id: z.uuid(),
      account: z.object({
        id: z.uuid(),
        original_id: z.string(),
        app_id: z.string().nullable().optional(),
      }),
    })
    .parse(req.body);
  if (sessions.has(body.id)) return { id: body.id };
  const pending = creatingSessions.get(body.id);
  if (pending) return pending;
  const releaseSession = sessionGate.acquire();
  const create = async () => {
    let context: BrowserContext | undefined;
    try {
      context = await contextFor();
      context.on("close", releaseSession);
      if (cancelledSessions.has(body.id)) throw new AppError("STOPPED", "连接已取消", 409);
      const page = await context.newPage();
      await page.goto("https://mp.weixin.qq.com/", {
        waitUntil: "domcontentloaded", timeout: 45000,
      });
      if (cancelledSessions.has(body.id)) throw new AppError("STOPPED", "连接已取消", 409);
      sessions.set(body.id, {
        context, page, account: body.account, created: Date.now(), state: "waiting_scan",
      });
      return { id: body.id };
    } catch (e) {
      await context?.close().catch(() => {});
      releaseSession();
      throw e;
    } finally {
      creatingSessions.delete(body.id);
      cancelledSessions.delete(body.id);
    }
  };
  const result = create();
  creatingSessions.set(body.id, result);
  return result;
});
api.get("/sessions/:id", async (req) => {
  const s = sessions.get((req.params as any).id);
  if (!s)
    throw new AppError("SESSION_EXPIRED", "扫码会话已过期，请重新创建", 410);
  await inspect(s);
  return {
    state: s.state,
    error: s.error,
    ...(s.state === "connected"
      ? { storageState: await s.context.storageState() }
      : {}),
  };
});
api.get("/sessions/:id/screen", async (req) => {
  const s = sessions.get((req.params as any).id);
  if (!s) throw new AppError("SESSION_EXPIRED", "扫码会话已过期", 410);
  await inspect(s);
  if (!["waiting_scan", "verifying"].includes(s.state))
    return { state: s.state };
  return {
    state: s.state,
    image: (await s.page.screenshot({ type: "jpeg", quality: 75 })).toString(
      "base64",
    ),
    width: 1180,
    height: 800,
  };
});
api.post("/sessions/:id/action", async (req) => {
  const s = sessions.get((req.params as any).id);
  if (!s) throw new AppError("SESSION_EXPIRED", "扫码会话已过期", 410);
  await inspect(s);
  if (!["waiting_scan", "verifying"].includes(s.state))
    throw new AppError("LOGIN_COMPLETE", "登录交互已经关闭", 409);
  const b = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("click"),
        x: z.number().min(0).max(1180),
        y: z.number().min(0).max(800),
      }),
      z.object({ type: z.literal("text"), text: z.string().max(200) }),
      z.object({
        type: z.literal("key"),
        key: z.enum(["Enter", "Tab", "Backspace", "Escape"]),
      }),
    ])
    .parse(req.body);
  if (b.type === "click") await s.page.mouse.click(b.x, b.y);
  else if (b.type === "text") await s.page.keyboard.insertText(b.text);
  else await s.page.keyboard.press(b.key);
  return { ok: true };
});
api.post("/sessions/:id/close", async (req) => {
  const id = (req.params as any).id;
  const pending = creatingSessions.get(id);
  if (pending) {
    cancelledSessions.add(id);
    await pending.catch(() => {});
  }
  const s = sessions.get(id);
  if (s) await s.context.close().catch(() => {});
  sessions.delete(id);
  return { ok: true };
});
async function authenticated(body: any) {
  const context = await contextFor(body.state);
  try {
    const page = await context.newPage();
    await page.goto("https://mp.weixin.qq.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (!new URL(page.url()).searchParams.has("token"))
      throw new AppError("AUTH_EXPIRED", "后台会话已过期，请重新扫码", 409);
    const id = await identify(page);
    if (!identityMatches(body.account, id))
      throw new AppError(
        "ACCOUNT_MISMATCH",
        "无法确认后台账号身份，停止读取",
        409,
      );
    return { context, page };
  } catch (e) {
    await context.close();
    throw e;
  }
}
api.post("/probe", async (req) => {
  const { context } = await authenticated(req.body);
  await context.close();
  return { ok: true };
});
api.post("/scans/:id/cancel", async (req) => {
  const scan = activeScan;
  if (scan && scan.id === (req.params as any).id) {
    scan.cancelled = true;
    await scan.context?.close().catch(() => {});
  }
  return { ok: true };
});
api.post("/scan", async (req) => {
  if (scanning)
    throw new AppError(
      "BROWSER_BUSY",
      "浏览器正在核对其他账号，请稍后重试",
      503,
      true,
    );
  scanning = true;
  activeScan = { id: (req.body as any).scanId, cancelled: false };
  let context: BrowserContext | undefined;
  try {
    const active = await authenticated(req.body);
    context = active.context;
    activeScan.context = context;
    if (activeScan.cancelled) throw new AppError("STOPPED", "任务已停止");
    const page = active.page;
    let last: any = null;
    let rate = false;
    const pending = new Set<Promise<void>>();
    page.on("response", (r) => {
      if (r.url().includes("/cgi-bin/appmsgpublish")) {
        const p = r
          .json()
          .then((data) => {
            if (data.base_resp?.ret === 200013) rate = true;
            const parsed = parsePublishResponse(data);
            if (parsed) last = parsed;
          })
          .catch(() => {})
          .finally(() => pending.delete(p));
        pending.add(p);
      }
    });
    const history = page.getByText("发表记录", { exact: true }).first();
    if (!(await history.count()))
      throw new AppError(
        "SOURCE_SCHEMA_CHANGED",
        "后台未找到发表记录入口，需要适配当前页面",
        409,
      );
    await history.click();
    await page.waitForTimeout(3000);
    await Promise.all([...pending]);
    const all = new Map<string, any>();
    const fingerprints = new Set<string>();
    let groups = 0;
    let total: number | undefined;
    let ended = false;
    let structured = true;
    for (let n = 0; n < 100; n++) {
      if (activeScan.cancelled) throw new AppError("STOPPED", "任务已停止");
      if (rate)
        throw new AppError("RATE_LIMIT", "后台触发频率限制，停止核对", 429);
      let items = last?.items;
      if (last) {
        groups += last.groups;
        total = last.total ?? total;
      }
      if (!items) {
        structured = false;
        const links = await page
          .locator('a[href*="mp.weixin.qq.com/s"]')
          .evaluateAll((nodes) =>
            nodes.map((n) => ({
              url: (n as HTMLAnchorElement).href,
              title: n.textContent?.trim() || "未命名文章",
            })),
          );
        items = links.map((x) => {
          const c = canonicalArticle(x.url);
          return { ...x, ...c, source: "browser", sourceId: c.key };
        });
      }
      const fp = items
        .map((x: any) => x.key)
        .sort()
        .join("|");
      if (fingerprints.has(fp) && fp)
        throw new AppError(
          "LIST_REPEATED",
          "后台分页重复，完整性尚未确认",
          409,
        );
      fingerprints.add(fp);
      for (const item of items) all.set(item.key, item);
      const next = page
        .locator(
          'a.page_next,button:has-text("下一页"),a:has-text("下一页"),[aria-label="下一页"]',
        )
        .first();
      const disabled =
        (await next.count()) === 0 ||
        !(await next.isVisible()) ||
        (await next.isDisabled()) ||
        /disabled/.test((await next.getAttribute("class")) ?? "");
      if (disabled) {
        ended = structured && total !== undefined && groups === total;
        break;
      }
      last = null;
      await next.click();
      await page.waitForTimeout(config.requestDelay);
      await Promise.all([...pending]);
    }
    return {
      items: [...all.values()],
      cursor: null,
      ended,
      totalMessages: total,
      messageCount: groups,
      evidence: ended ? "backend_count_reconciled" : "backend_unverified",
    };
  } finally {
    scanning = false;
    activeScan = undefined;
    await context?.close().catch(() => {});
  }
});
setInterval(async () => {
  for (const [id, s] of sessions)
    if (Date.now() - s.created > 600000) {
      await s.context.close().catch(() => {});
      sessions.delete(id);
    }
}, 30000).unref();
await api.listen({ host: "0.0.0.0", port: 3001 });
process.on("SIGTERM", async () => {
  shuttingDown = true;
  await api.close();
  await browser.close();
});
