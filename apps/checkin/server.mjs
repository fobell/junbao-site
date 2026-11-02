// 扫码签到 · tools.junbao.ai/checkin/
// Zero-dependency Node server. Caddy strips the /checkin prefix, so routes here start at "/".
// State lives in one JSON file under DATA_DIR; ADMIN_TOKEN guards clear / delete / export / title.
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || join(root, "data");
const FILE = join(DATA_DIR, "checkins.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_ITEMS = 3000;
const NAME_MAX = 20;

let state = { title: process.env.CHECKIN_TITLE || "现场签到", startedAt: Date.now(), items: [] };
let version = Date.now();
try { state = { ...state, ...JSON.parse(await readFile(FILE, "utf8")) }; } catch {}
await mkdir(DATA_DIR, { recursive: true });

let saving = Promise.resolve();
function save() {
  version++;
  const body = JSON.stringify(state);
  saving = saving.then(async () => { const tmp = FILE + ".tmp"; await writeFile(tmp, body); await rename(tmp, FILE); }).catch((e) => console.error("save failed", e));
  return saving;
}

const pages = {};
for (const p of ["index.html", "screen.html", "admin.html", "qr.svg", "icon.svg"]) pages[p] = await readFile(join(root, "public", p));
const TYPES = { html: "text/html; charset=utf-8", svg: "image/svg+xml" };

// per-IP limiter for check-ins: 40 per minute (a whole venue on one Wi-Fi shares an IP)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60e3, list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > win) hits.delete(k);
  return list.length > 40;
}

const RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const INVISIBLE = new RegExp("[" + RANGES.map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]", "g");
const norm = (s) => String(s ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
const key = (s) => norm(s).toLowerCase().replace(/\s/g, "");

function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function isAdmin(req) {
  const got = Buffer.from(String(req.headers["x-admin-token"] || ""));
  const want = Buffer.from(ADMIN_TOKEN);
  return ADMIN_TOKEN.length >= 12 && got.length === want.length && timingSafeEqual(got, want);
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 4096) throw Object.assign(new Error("too large"), { code: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("bad json"), { code: 400 }); }
}
const pub = () => ({ title: state.title, startedAt: state.startedAt, count: state.items.length, version, items: state.items });
const csv = () => String.fromCharCode(0xfeff) + "序号,姓名,签到时间\n" + state.items.map((i) => `${i.n},"${i.name.replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}",${new Date(i.t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`).join("\n") + "\n";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const html = { "/": "index.html", "/index.html": "index.html", "/screen": "screen.html", "/admin": "admin.html" }[p];
    if (req.method === "GET" && html) return send(res, 200, pages[html], TYPES.html, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
    if (req.method === "GET" && (p === "/qr.svg" || p === "/icon.svg")) return send(res, 200, pages[p.slice(1)], TYPES.svg, { "Cache-Control": "public, max-age=3600" });
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });

    if (req.method === "GET" && p === "/api/list") {
      const since = Number(url.searchParams.get("v"));
      if (since === version) return send(res, 200, { version, same: true });
      return send(res, 200, pub());
    }
    if (req.method === "POST" && p === "/api/checkin") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (limited(ip)) return send(res, 429, { error: "签到太频繁了，请稍后再试。" });
      const name = norm((await body(req)).name);
      if (!name) return send(res, 400, { error: "请填写姓名。" });
      if ([...name].length > NAME_MAX) return send(res, 400, { error: `姓名最多 ${NAME_MAX} 个字。` });
      const dup = state.items.find((i) => key(i.name) === key(name));
      if (dup) return send(res, 409, { error: `「${dup.name}」已经签到过了，是第 ${dup.n} 位。`, item: dup });
      if (state.items.length >= MAX_ITEMS) return send(res, 507, { error: "签到人数已满。" });
      const item = { n: state.items.length ? state.items[state.items.length - 1].n + 1 : 1, name, t: Date.now() };
      state.items.push(item); await save();
      return send(res, 201, { item, count: state.items.length });
    }

    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "管理口令不正确。" });
      if (req.method === "GET" && p === "/api/admin/export.csv") return send(res, 200, csv(), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="checkin-${new Date().toISOString().slice(0, 10)}.csv"` });
      if (req.method === "POST" && p === "/api/admin/check") return send(res, 200, { ok: true });
      if (req.method === "POST" && p === "/api/admin/title") {
        const title = norm((await body(req)).title);
        if (!title || [...title].length > 40) return send(res, 400, { error: "标题 1–40 个字。" });
        state.title = title; await save(); return send(res, 200, pub());
      }
      if (req.method === "POST" && p === "/api/admin/delete") {
        const n = Number((await body(req)).n);
        const before = state.items.length; state.items = state.items.filter((i) => i.n !== n);
        if (state.items.length === before) return send(res, 404, { error: "没有这条签到。" });
        await save(); return send(res, 200, pub());
      }
      if (req.method === "POST" && p === "/api/admin/reset") {
        const b = await body(req);
        state = { title: norm(b.title) || state.title, startedAt: Date.now(), items: [] };
        await save(); return send(res, 200, pub());
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code ? "请求无效。" : "服务器出错了，请重试。" });
    if (!e.code) console.error(e);
  }
});
server.listen(PORT, () => console.log(`checkin on :${PORT}, admin ${ADMIN_TOKEN.length >= 12 ? "enabled" : "disabled (set ADMIN_TOKEN, 12+ chars)"}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); saving.finally(() => process.exit(0)); });
