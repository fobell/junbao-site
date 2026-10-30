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
const lock = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
const entries = tools.sort((a, b) => a.order - b.order).map((t) => `<li><article class="tool" aria-labelledby="${esc(t.id)}">
  <img class="tool-icon" src="/hub-assets/${esc(t.icon)}" width="120" height="120" alt="">
  <div><p class="category">${esc(t.category)}</p><h2 id="${esc(t.id)}">${esc(t.name)}</h2><p class="description">${esc(t.description)}</p></div>
  <div class="tool-action"><a class="open-tool" href="${esc(t.url)}" aria-label="打开工具：${esc(t.name)}">打开工具</a><p class="access">${t.access === "需要登录" ? lock : ""}${esc(t.access)}</p></div>
</article></li>`).join("\n");
await writeFile(join(root, "dist/index.html"), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B0B0D">
<title>钧宝工具箱 · JUNBAO</title><meta name="description" content="钧宝开发与部署的在线工具。查看工具介绍，从这里进入公众号文章归档等工作空间。">
<link rel="canonical" href="https://tools.junbao.ai/"><meta property="og:title" content="钧宝工具箱"><meta property="og:description" content="我开发与部署的在线工具，集中在这里。"><meta property="og:url" content="https://tools.junbao.ai/"><meta property="og:type" content="website">
<link rel="icon" href="/hub-assets/junbao-symbol-white.png"><link rel="stylesheet" href="/hub-assets/${styleName}"></head>
<body><a class="skip" href="#tools">跳到工具列表</a>
<header class="masthead"><div class="wrap"><a class="logo" href="/" aria-label="钧宝工具箱首页"><img src="/hub-assets/junbao-lockup-white.png" alt="JUNBAO" width="150" height="24"></a><nav aria-label="站点导航"><a class="home" href="https://junbao.ai/">个人主页</a></nav></div></header>
<main class="wrap" id="tools"><div class="intro"><h1>钧宝工具箱</h1><p>我开发与部署的在线工具，集中在这里。<br>找到需要的工具，开始使用。</p></div><ul class="tool-list" aria-label="在线工具">${entries}</ul></main>
<footer><div class="wrap"><p>© ${new Date().getFullYear()} JUNBAO</p><p>工具持续更新。</p></div></footer></body></html>\n`);
console.log(`Built tools hub with ${tools.length} tool(s).`);
