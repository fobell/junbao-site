import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as fetchUndici } from "undici";
import { AppError } from "../shared/types.js";
export type Policy = "article" | "image" | "wechat" | "browser";
const articleHosts = ["mp.weixin.qq.com"];
const imageHosts = [
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
  "mmbiz.qpic.cn",
  "res.wx.qq.com",
  "res2.wx.qq.com",
  "res8.wxqcloud.qq.com",
];
export function allowedHost(host: string, policy: Policy) {
  host = host.toLowerCase();
  if (policy === "article") return articleHosts.includes(host);
  if (policy === "image") return imageHosts.includes(host);
  if (policy === "wechat") return host === "api.weixin.qq.com";
  return (
    [
      ...articleHosts,
      ...imageHosts,
      "open.weixin.qq.com",
      "login.weixin.qq.com",
    ].includes(host) || /^res\d*\.wx\.qq\.com$/.test(host)
  );
}
export function validateUrl(input: string, policy: Policy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError("INVALID_URL", "链接格式不正确");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname) ||
    !allowedHost(url.hostname, policy)
  )
    throw new AppError("URL_NOT_ALLOWED", "仅允许受支持的微信 HTTPS 地址");
  if (
    policy === "article" &&
    url.pathname !== "/s" &&
    !/^\/s\/[A-Za-z\d_-]+$/.test(url.pathname)
  )
    throw new AppError("URL_NOT_ALLOWED", "请提供公众号文章链接");
  url.hash = "";
  return url;
}
export function publicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    isIP(ip) === 6 &&
    /^[23]/i.test(ip) &&
    !ip.toLowerCase().startsWith("2001:db8:")
  );
}
export async function resolvePublic(hostname: string) {
  const records = await lookup(hostname, { all: true });
  if (!records.length || records.some((x) => !publicIp(x.address)))
    throw new AppError("PRIVATE_ADDRESS", "目标地址不允许访问");
  return records.find((x) => x.family === 4) ?? records[0];
}
export async function safeFetch(
  input: string,
  policy: Policy,
  options: {
    method?: string;
    body?: string;
    maxBytes?: number;
    timeout?: number;
  } = {},
): Promise<{ body: Buffer; mime: string; url: string; status: number }> {
  let target = input;
  for (let redirects = 0; redirects < 5; redirects++) {
    const url = validateUrl(target, policy);
    const address = await resolvePublic(url.hostname);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, opts, cb: any) =>
          opts.all
            ? cb(null, [address])
            : cb(null, address.address, address.family),
      },
    });
    try {
      const response = await fetchUndici(url, {
        method: options.method ?? "GET",
        body: options.body,
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeout ?? 30000),
        headers: {
          "user-agent": "WechatArchive/1.0 (private account archive)",
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location");
        await response.body?.cancel();
        if (!next || options.method === "POST")
          throw new AppError("UNEXPECTED_REDIRECT", "接口返回意外跳转");
        target = new URL(next, url).href;
        continue;
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const milliseconds = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : 0;
        await response.body?.cancel();
        throw new AppError(
          "RATE_LIMIT",
          "微信限制了请求频率，请稍后继续",
          429,
          false,
          Number.isFinite(milliseconds) ? Math.max(milliseconds, 0) : 0,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 404 ? "ARTICLE_UNAVAILABLE" : "UPSTREAM_ERROR",
          `上游返回 HTTP ${response.status}`,
          502,
          response.status >= 500,
        );
      }
      const limit = options.maxBytes ?? 8 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new AppError("RESOURCE_TOO_LARGE", "资源超过大小限制");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (response.body)
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > limit) {
            throw new AppError("RESOURCE_TOO_LARGE", "资源超过大小限制");
          }
          chunks.push(Buffer.from(chunk));
        }
      return {
        body: Buffer.concat(chunks),
        mime: (response.headers.get("content-type") ?? "").split(";")[0],
        url: url.href,
        status: response.status,
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new AppError("TOO_MANY_REDIRECTS", "链接跳转次数过多");
}
export function canonicalArticle(input: string) {
  const url = validateUrl(input, "article");
  const biz = url.searchParams.get("__biz");
  const mid = url.searchParams.get("mid");
  const idx = url.searchParams.get("idx");
  if (biz && mid && idx) {
    const clean = new URL("https://mp.weixin.qq.com/s");
    for (const k of ["__biz", "mid", "idx", "sn"]) {
      const v = url.searchParams.get(k);
      if (v) clean.searchParams.set(k, v);
    }
    return { key: `${biz}:${mid}:${idx}`, biz, url: clean.href };
  }
  return {
    key: url.pathname === "/s" ? url.href : url.pathname.slice(3),
    biz: biz ?? undefined,
    url: url.href,
  };
}
