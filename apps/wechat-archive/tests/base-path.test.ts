import { describe, it, expect } from "vitest";
import { normalizeBasePath, applicationUrl } from "../src/shared/base-path.mjs";
import { publicPreview } from "../src/server/public-content.js";

describe("shared gateway paths", () => {
  it("keeps root deployments compatible and normalizes a subpath", () => {
    expect(normalizeBasePath()).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("/wechat-article-archive/")).toBe(
      "/wechat-article-archive",
    );
    expect(
      applicationUrl("https://tools.junbao.ai", "/wechat-article-archive"),
    ).toBe("https://tools.junbao.ai/wechat-article-archive/");
    expect(applicationUrl("https://archive.company.cn", "")).toBe(
      "https://archive.company.cn",
    );
  });
  it("rejects ambiguous paths before a deployment can publish broken links", () => {
    for (const path of [
      "relative",
      "//external.test",
      "/a//b",
      "/a/../b",
      "/a?x=1",
      "/a#b",
      "/%2f",
      "/a\\b",
      " /a",
    ])
      expect(() => normalizeBasePath(path)).toThrow();
  });
  it("scopes historical preview images without rewriting links, text or external resources", () => {
    const id = "e0c2f2c9-bb64-46b5-a40a-52fb7c7c6bd3";
    const html = `<p>/api/v1/assets/${id}</p><a href="https://mp.weixin.qq.com/s/x">原文</a><img src="/api/v1/assets/${id}" alt="归档图片"><img src="https://example.org/api/v1/assets/${id}"><img src="/wechat-article-archive/api/v1/assets/${id}">`;
    const output = publicPreview(html, "/wechat-article-archive");
    expect(output).toContain(`<p>/api/v1/assets/${id}</p>`);
    expect(output).toContain('href="https://mp.weixin.qq.com/s/x"');
    expect(output).toContain(`src="https://example.org/api/v1/assets/${id}"`);
    expect(
      output.match(/src="\/wechat-article-archive\/api\/v1\/assets\//g),
    ).toHaveLength(2);
    expect(publicPreview(output, "/wechat-article-archive")).toBe(output);
    expect(publicPreview(html, "")).toBe(html);
  });
});
