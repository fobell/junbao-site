import { parseHTML } from "linkedom";
import sanitize from "sanitize-html";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { AppError } from "../shared/types.js";
import { canonicalArticle, validateUrl } from "./network.js";
import { hash } from "./security.js";
export interface Metadata {
  title: string;
  author: string | null;
  publishedAt: string | null;
  accountName: string;
  accountId: string;
  sourceUrl: string;
  articleId: string;
  archivedAt: string;
}
export interface ImageResult {
  url: string;
  assetId?: string;
  hash?: string;
  ext?: string;
  error?: string;
}
function scriptValue(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `\\b(?:var\\s+)?${name}\\s*(?:=|:)\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|(\\d{1,16}))`,
    );
    const m = html.match(re);
    if (m) return (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, "&");
  }
  return null;
}
export function extractPage(html: string, fallbackUrl: string) {
  const { document } = parseHTML(html);
  const scripts = [...document.querySelectorAll("script")]
    .map((n) => n.textContent ?? "")
    .join("\n");
  const content = document.querySelector("#js_content");
  if (
    !content ||
    (!content.textContent?.trim() && !content.querySelector("img,video,iframe"))
  ) {
    if (
      /环境异常|访问过于频繁|验证后继续访问|完成验证/.test(
        document.body.textContent ?? "",
      )
    )
      throw new AppError("VERIFICATION_REQUIRED", "微信要求完成访问验证", 409);
    throw new AppError(
      "ARTICLE_UNAVAILABLE",
      "没有找到文章正文，文章可能已删除或当前无法访问",
      422,
    );
  }
  const title =
    document.querySelector("#activity-name")?.textContent?.trim() ||
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content") ||
    document.title;
  const author =
    document.querySelector("#js_author_name")?.textContent?.trim() ||
    scriptValue(scripts, ["author"]) ||
    null;
  const seconds = scriptValue(scripts, ["ct", "publish_time"]);
  const date =
    seconds && /^\d{10}$/.test(seconds)
      ? new Date(Number(seconds) * 1000).toISOString()
      : null;
  const biz =
    scriptValue(scripts, ["biz"]) || canonicalArticle(fallbackUrl).biz;
  const mid = scriptValue(scripts, ["mid", "appmsgid"]),
    idx = scriptValue(scripts, ["idx", "itemidx"]);
  return {
    html: content.innerHTML,
    title,
    author,
    publishedAt: date,
    biz,
    platformKey: biz && mid && idx ? `${biz}:${mid}:${idx}` : null,
    originalId: scriptValue(scripts, ["user_name"]),
    nickname: scriptValue(scripts, ["nickname"]),
  };
}
export function prepareContent(html: string) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const warnings: string[] = [];
  document
    .querySelectorAll(
      "script,style,noscript,form,input,button,.js_ad_link,.advertisement",
    )
    .forEach((n) => n.remove());
  document
    .querySelectorAll("iframe,video,audio,mpvoice,mpvideo,mp-common-videosnap")
    .forEach((n) => {
      const link = n.getAttribute("src") || n.getAttribute("data-src");
      const p = document.createElement("p");
      p.textContent = "[音视频内容：请通过原文查看]";
      if (link?.startsWith("https://")) {
        const a = document.createElement("a");
        a.href = link;
        a.textContent = "查看媒体";
        p.append(" ", a);
      }
      n.replaceWith(p);
      warnings.push("音视频保留原文入口，未下载媒体文件");
    });
  document.querySelectorAll("[style]").forEach((n) => {
    const match = n
      .getAttribute("style")
      ?.match(/background(?:-image)?\s*:[^;]*url\(["']?([^"')]+)["']?\)/i);
    if (match && !n.querySelector("img")) {
      const img = document.createElement("img");
      img.setAttribute("src", match[1]);
      img.setAttribute("alt", "正文背景图片");
      n.append(img);
    }
  });
  const images: string[] = [];
  document.querySelectorAll("img").forEach((img) => {
    let src =
      img.getAttribute("data-src") ||
      img.getAttribute("src") ||
      img.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0] ||
      "";
    if (src.startsWith("//")) src = `https:${src}`;
    try {
      const u = validateUrl(src, "image").href;
      img.setAttribute("src", u);
      if (!images.includes(u)) images.push(u);
    } catch {
      img.replaceWith(
        document.createTextNode("[图片地址不受支持，请查看原文]"),
      );
      warnings.push("存在不受支持的图片地址");
    }
  });
  const clean = sanitize(document.body.innerHTML, {
    allowedTags: [
      ...sanitize.defaults.allowedTags,
      "img",
      "h1",
      "h2",
      "details",
      "summary",
      "del",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"],
      code: ["class"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https", "http", "mailto"],
    disallowedTagsMode: "discard",
  });
  const plain =
    parseHTML(`<html><body>${clean}</body></html>`).document.body.textContent ??
    "";
  if (!plain.trim() && !images.length)
    throw new AppError("EMPTY_CONTENT", "正文为空，未生成归档", 422);
  return {
    clean,
    plain,
    images,
    warnings: [...new Set(warnings)],
    contentHash: hash(clean),
  };
}
export function renderContent(
  clean: string,
  metadata: Metadata,
  results: ImageResult[],
  warnings: string[] = [],
) {
  const { document } = parseHTML(`<html><body>${clean}</body></html>`);
  const preview = parseHTML(`<html><body>${clean}</body></html>`).document;
  for (const img of [...document.querySelectorAll("img")]) {
    const r = results.find((r) => r.url === img.getAttribute("src"));
    if (r?.assetId) img.setAttribute("src", `images/${r.hash}.${r.ext}`);
  }
  for (const img of [...preview.querySelectorAll("img")]) {
    const r = results.find((r) => r.url === img.getAttribute("src"));
    if (r?.assetId) img.setAttribute("src", `/api/v1/assets/${r.assetId}`);
    else img.replaceWith(preview.createTextNode("[图片尚未归档]"));
  }
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);
  td.addRule("wechat-break", { filter: "br", replacement: () => "  \n" });
  const front: Record<string, string | null> = {
    title: metadata.title,
    author: metadata.author,
    account: metadata.accountName,
    account_id: metadata.accountId,
    article_id: metadata.articleId,
    published_at: metadata.publishedAt,
    source: metadata.sourceUrl,
    archived_at: metadata.archivedAt,
  };
  const failed = results.filter((x) => !x.assetId);
  const notes = [
    ...warnings,
    ...(failed.length
      ? [`${failed.length} 张图片未完成本地归档，保留网络链接`]
      : []),
  ];
  const md = `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${v === null ? "null" : JSON.stringify(v)}`)
    .join(
      "\n",
    )}\n---\n\n# ${metadata.title.replace(/\n/g, " ")}\n\n${notes.map((x) => `> 归档说明：${x}\n`).join("")}\n${td.turndown(document.body.innerHTML)}\n`;
  return { markdown: md, previewHtml: preview.body.innerHTML };
}
export function imageType(body: Buffer): { mime: string; ext: string } | null {
  if (
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", ext: "png" };
  if (body[0] === 255 && body[1] === 216 && body[2] === 255)
    return { mime: "image/jpeg", ext: "jpg" };
  if (/^GIF8[79]a/.test(body.subarray(0, 6).toString()))
    return { mime: "image/gif", ext: "gif" };
  if (
    body.subarray(0, 4).toString() === "RIFF" &&
    body.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  return null;
}
