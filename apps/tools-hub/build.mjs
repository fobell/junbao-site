import { readFile, writeFile, mkdir, cp, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(await readFile(join(root, "tools.json"), "utf8"));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ids = new Set();
if (!Array.isArray(tools) || !tools.length) throw new Error("Add at least one tool to tools.json");
for (const tool of tools) {
  if (!/^[a-z0-9-]+$/.test(tool.id) || ids.has(tool.id)) throw new Error("Tool ids must be unique slugs");
  ids.add(tool.id);
  for (const key of ["name", "category", "description", "url", "icon", "access"])
    if (typeof tool[key] !== "string" || !tool[key].trim()) throw new Error(`Missing ${key}: ${tool.id}`);
  const url = new URL(tool.url, "https://tools.junbao.ai");
  if (!(tool.url.startsWith("/") && !tool.url.startsWith("//") || tool.url.startsWith("https://")) || url.protocol !== "https:" || url.username || url.password || /[\\\s]/.test(tool.url)) throw new Error(`Invalid URL: ${tool.id}`);
  if (!/^[a-z0-9-]+\.(svg|png|webp)$/.test(tool.icon) || !Number.isFinite(tool.order)) throw new Error(`Invalid icon or order: ${tool.id}`);
  await access(join(root, "public", tool.icon));
}
const css = await readFile(join(root, "style.css"));
const styleName = `style-${createHash("sha256").update(css).digest("hex").slice(0, 12)}.css`;
await mkdir(join(root, "dist/hub-assets"), { recursive: true });
await cp(join(root, "public"), join(root, "dist/hub-assets"), { recursive: true });
await writeFile(join(root, "dist/hub-assets", styleName), css);
const lock = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
const arrow = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const pad = (n) => String(n).padStart(2, "0");
const shown = (u) => (u.startsWith("/") ? "tools.junbao.ai" + u : u.replace(/^https:\/\//, "")).replace(/\/$/, "");
const sorted = tools.sort((a, b) => a.order - b.order);
const entries = sorted.map((t, i) => `<li class="tool" style="--i:${i}"><article aria-labelledby="${esc(t.id)}">
  <span class="tool-no" aria-hidden="true">${pad(i + 1)}</span>
  <div class="tool-icon"><img src="/hub-assets/${esc(t.icon)}" width="120" height="120" alt=""></div>
  <div class="tool-body">
    <p class="category">${esc(t.category)}</p>
    <h2 id="${esc(t.id)}">${esc(t.name)}</h2>
    <p class="description">${esc(t.description)}</p>
  </div>
  <div class="tool-foot">
    <p class="meta"><span class="access">${t.access === "需要登录" ? lock : ""}${esc(t.access)}</span><span class="addr">${esc(shown(t.url))}</span></p>
    <a class="open-tool" href="${esc(t.url)}" aria-label="打开工具：${esc(t.name)}"><span>打开工具</span>${arrow}</a>
  </div>
</article></li>`).join("\n");
const site = "https://junbao.ai/";
await writeFile(join(root, "dist/index.html"), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0B0B0D">
<title>钧宝工具箱 · JUNBAO Tools</title><meta name="description" content="钧宝开发与部署的在线工具。查看工具介绍，从这里进入公众号文章归档等工作空间。">
<link rel="canonical" href="https://tools.junbao.ai/"><meta property="og:title" content="钧宝工具箱"><meta property="og:description" content="我开发与部署的在线工具，集中在这里。"><meta property="og:url" content="https://tools.junbao.ai/"><meta property="og:type" content="website">
<link rel="icon" href="/hub-assets/junbao-symbol-white.png">
<link rel="preload" href="/hub-assets/fonts/bodoni-moda-900-italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/hub-assets/${styleName}"></head>
<body><a class="skip" href="#tools">跳到工具列表</a>
<header class="top"><div class="wrap">
  <a class="logo" href="${site}" aria-label="钧宝 JUNBAO 个人主页"><img class="logo-full" src="/hub-assets/junbao-lockup-white.png" alt="JUNBAO" width="120" height="19"><img class="logo-mark" src="/hub-assets/junbao-symbol-white.png" alt="JUNBAO" width="26" height="26"></a>
  <nav class="nav" aria-label="站点导航">
    <a href="${site}#film">电影</a><a href="${site}ai.html">AI</a><a href="${site}works.html">作品</a><a href="/" aria-current="page">工具</a>
  </nav>
</div></header>
<main>
<section class="hero" aria-labelledby="hub-title">
  <div class="hero-bg" aria-hidden="true"><span class="word">TOOLS</span><span class="word ghost">TOOLS</span></div>
  <div class="wrap">
    <p class="eyebrow"><span class="dot" aria-hidden="true"></span>JUNBAO TOOLS · 在线工具</p>
    <h1 id="hub-title">钧宝<em>工具箱</em></h1>
    <p class="lede">我开发并部署的在线工具，集中在这里。<br>每个工具独立登录，打开即用。</p>
    <dl class="stats">
      <div><dt>已上线</dt><dd>${pad(sorted.length)}</dd></div>
      <div><dt>状态</dt><dd class="live"><span class="dot" aria-hidden="true"></span>持续更新</dd></div>
    </dl>
  </div>
</section>
<section class="list" id="tools" aria-labelledby="list-title">
  <div class="wrap">
    <div class="list-head"><h2 id="list-title" class="label">工具列表 <span lang="en">/ TOOLS</span></h2><span class="label">${pad(sorted.length)} ${sorted.length === 1 ? "ITEM" : "ITEMS"}</span></div>
    <ul class="tool-list${sorted.length === 1 ? " single" : ""}" aria-label="在线工具">${entries}</ul>
  </div>
</section>
</main>
<footer><div class="wrap">
  <p class="f-l"><img src="/hub-assets/junbao-symbol-white.png" alt="" width="20" height="20">© ${new Date().getFullYear()} 钧宝 JUNBAO</p>
  <p class="f-r"><a href="${site}">junbao.ai</a><a href="https://prompt.junbao.ai/">prompt.junbao.ai ↗</a></p>
</div></footer>
</body></html>\n`);
console.log(`Built tools hub with ${tools.length} tool(s).`);
