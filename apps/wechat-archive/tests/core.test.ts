import { describe, it, expect } from "vitest";
import {
  seal,
  unseal,
  passwordHash,
  checkPassword,
  base32,
  totp,
  verifyTotp,
  safeFilename,
  csvCell,
} from "../src/server/security.js";
import {
  validateUrl,
  publicIp,
  canonicalArticle,
} from "../src/server/network.js";
import {
  prepareContent,
  renderContent,
  extractPage,
} from "../src/server/content.js";
import { flattenOfficial } from "../src/server/sources.js";
import {
  identityMatches,
  parsePublishResponse,
} from "../src/browser/parser.js";
import { LocalStore, checkKey } from "../src/server/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("credential and input security", () => {
  it("binds encrypted secrets to account and rejects tampering", () => {
    const key = "12".repeat(32);
    const token = seal({ secret: "private" }, "account-A", key);
    expect(unseal(token, "account-A", key)).toEqual({ secret: "private" });
    expect(() => unseal(token, "account-B", key)).toThrow();
    expect(() =>
      unseal(token.slice(0, -4) + "AAAA", "account-A", key),
    ).toThrow();
  });
  it("hashes passwords with salt", async () => {
    const h = await passwordHash("example-only-password");
    expect(await checkPassword("example-only-password", h)).toBe(true);
    expect(await checkPassword("wrong-password", h)).toBe(false);
    expect(h).not.toBe(await passwordHash("example-only-password"));
  });
  it("implements the RFC TOTP vector and rejects reused steps", () => {
    const secret = base32(Buffer.from("12345678901234567890"));
    expect(totp(secret, 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", -1, 59000)).toBe(1);
    expect(verifyTotp(secret, "287082", 1, 59000)).toBeNull();
  });
  it.each([
    "http://mp.weixin.qq.com/s/a",
    "https://127.0.0.1/s/a",
    "https://mp.weixin.qq.com.evil.test/s/a",
    "https://mp.weixin.qq.com@evil.test/s/a",
    "https://mp.weixin.qq.com:8443/s/a",
    "https://mp.weixin.qq.com/cgi-bin/home",
  ])("rejects unsafe URL %s", (url) =>
    expect(() => validateUrl(url, "article")).toThrow(),
  );
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
  ])("blocks private address %s", (ip) => expect(publicIp(ip)).toBe(false));
  it("normalizes tracking aliases without using the title", () => {
    const a = canonicalArticle(
      "https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=2&sn=abc&scene=1",
    );
    expect(a.key).toBe("ABC:123:2");
    expect(a.url).not.toContain("scene");
  });
  it("uses safe export paths and CSV cells", () => {
    expect(safeFilename("../../危险:<标题>")).not.toMatch(/[/:<>]/);
    expect(safeFilename("CON")).toBe("_CON");
    expect(csvCell('=HYPERLINK("evil")').startsWith("\"'=")).toBe(true);
    expect(() => checkKey("../keys")).toThrow();
  });
});
describe("content fidelity and parser boundaries", () => {
  it("converts Chinese, tables, code, quotes, lazy images and removes active HTML", () => {
    const p = prepareContent(
      '<h2>中文标题</h2><script>alert(1)</script><p onclick="evil()">段落 <a href="javascript:alert(1)">链接</a></p><blockquote>引用</blockquote><pre><code>const x = 1</code></pre><table><tr><th>名称</th></tr><tr><td>资料</td></tr></table><img data-src="https://mmbiz.qpic.cn/a" onerror="evil()">',
    );
    expect(p.images).toEqual(["https://mmbiz.qpic.cn/a"]);
    expect(p.clean).not.toMatch(/script|onclick|onerror|javascript/);
    const r = renderContent(
      p.clean,
      {
        title: "测试",
        author: null,
        publishedAt: null,
        accountName: "公众号",
        accountId: "a",
        articleId: "b",
        sourceUrl: "https://mp.weixin.qq.com/s/test",
        archivedAt: "2026-01-01",
      },
      [{ url: p.images[0], assetId: "id", hash: "sha", ext: "png" }],
    );
    expect(r.markdown).toContain("images/sha.png");
    expect(r.markdown).toContain("## 中文标题");
    expect(r.markdown).toContain("author: null");
    expect(r.markdown).toContain("| 名称 |");
    expect(r.previewHtml).toContain("/api/v1/assets/id");
  });
  it("flags unsupported images and preserves failed network references", () => {
    const p = prepareContent(
      '<p>正文</p><img src="http://127.0.0.1/x"><img src="https://mmbiz.qpic.cn/missing">',
    );
    expect(p.warnings.length).toBe(1);
    const r = renderContent(
      p.clean,
      {
        title: "测试",
        author: null,
        publishedAt: null,
        accountName: "账号",
        accountId: "a",
        articleId: "b",
        sourceUrl: "https://mp.weixin.qq.com/s/a",
        archivedAt: "2026",
      },
      [{ url: p.images[0], error: "failed" }],
    );
    expect(r.markdown).toContain("https://mmbiz.qpic.cn/missing");
    expect(r.markdown).toContain("1 张图片");
    expect(r.previewHtml).not.toContain("<img");
  });
  it("never substitutes update time for publication time", () => {
    const p = flattenOfficial({
      total_count: 1,
      item: [
        {
          article_id: "id",
          update_time: 1234,
          content: {
            news_item: [
              { title: "头条", content: "<p>1</p>" },
              { title: "次条", content: "<p>2</p>" },
            ],
          },
        },
      ],
    });
    expect(p.items).toHaveLength(2);
    expect(p.items[0].publishedAt).toBeNull();
    expect(p.messageCount).toBe(1);
  });
  it("expands backend groups without confusing creation and publication times", () => {
    const parsed = parsePublishResponse({
      publish_page: JSON.stringify({
        total_count: 1,
        publish_list: [
          {
            publish_info: JSON.stringify({
              create_time: 1600000000,
              appmsgex: [
                {
                  title: "主条",
                  link: "https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=1",
                  create_time: 1600000000,
                },
                {
                  title: "次条",
                  link: "https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=2",
                  publish_time: 1700000000,
                },
              ],
            }),
          },
        ],
      }),
    });
    expect(parsed?.groups).toBe(1);
    expect(parsed?.total).toBe(1);
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.items[0].publishedAt).toBeNull();
    expect(parsed?.items[1].publishedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(parsed?.items[1].key).toBe("ABC:123:2");
  });
  it("rejects parser drift and login-account conflicts", () => {
    expect(() => flattenOfficial({ items: [] })).toThrow();
    expect(
      identityMatches(
        { original_id: "gh_a", app_id: "wxa" },
        { originalId: "gh_b", appId: "wxa" },
      ),
    ).toBe(false);
    expect(identityMatches({ original_id: "gh_a" }, {})).toBe(false);
    expect(
      identityMatches({ original_id: "gh_a" }, { originalId: "gh_a" }),
    ).toBe(true);
  });
  it("extracts short-link identity without executing scripts", () => {
    const p = extractPage(
      '<html><body><h1 id="activity-name">标题</h1><div id="js_content">正文</div><script>var biz="ABC";var mid="123";var idx="2";var ct="1700000000";var user_name="gh_test";</script></body></html>',
      "https://mp.weixin.qq.com/s/short",
    );
    expect(p.platformKey).toBe("ABC:123:2");
    expect(p.originalId).toBe("gh_test");
    expect(p.publishedAt).toBe("2023-11-14T22:13:20.000Z");
  });
  it("stores binary data atomically and rejects path traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wechat-test-"));
    try {
      const s = new LocalStore(dir);
      await s.put("assets/a", Buffer.from("bytes"));
      const parts = [];
      for await (const p of await s.get("assets/a")) parts.push(p);
      expect(Buffer.concat(parts).toString()).toBe("bytes");
      expect(await s.size("assets/a")).toBe(5);
      expect(() => s.path("../secret")).toThrow();
      await s.remove("assets/a");
      await expect(s.get("assets/a")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
