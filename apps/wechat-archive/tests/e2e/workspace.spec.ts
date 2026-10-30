import { test, expect } from "@playwright/test";
import { db, one, pool } from "../../src/server/db.js";
import { config } from "../../src/server/config.js";
import { totp, hash } from "../../src/server/security.js";
import { renderContent, prepareContent } from "../../src/server/content.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { store } from "../../src/server/storage.js";
import sharp from "sharp";
test.beforeAll(async () => {
  if (
    !/^postgres:\/\/archive:archive@(127\.0\.0\.1|host\.docker\.internal):25432\/archive$/.test(
      config.databaseUrl,
    )
  )
    throw new Error("Isolated test database required");
  await db.query("TRUNCATE users,accounts,system_status CASCADE");
  await mkdir("artifacts", { recursive: true });
});
test.afterAll(async () => {
  await pool.end();
});
test("bootstrap, TOTP, account, search, preview, tags, queued ZIP and mobile navigation", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  if (config.basePath) {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "钧宝工具箱" }),
    ).toBeVisible();
    await page.screenshot({
      path: "artifacts/tools-hub-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "artifacts/tools-hub-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "打开工具：文藏" }).click();
    await expect(page).toHaveURL(new RegExp(`${config.basePath}/$`));
    await page.getByRole("link", { name: "所有工具" }).click();
    await expect(
      page.getByRole("heading", { name: "钧宝工具箱" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1024 });
  }
  await page.goto(`${config.basePath}/`);
  await page.screenshot({
    path: "artifacts/archive-setup-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("一次性安装凭证").fill(config.bootstrapToken);
  await page.getByLabel("姓名", { exact: true }).fill("验收管理员");
  await page.getByLabel("用户名", { exact: true }).fill("acceptance");
  await page
    .getByLabel("密码", { exact: true })
    .fill("Archive-acceptance-2026!");
  await page.getByRole("button", { name: "创建并继续" }).click();
  await expect(
    page.getByRole("heading", { name: "保护你的资料库" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置验证器" }).click();
  const secret = await page.locator("code").textContent();
  await page
    .getByLabel("六位验证码")
    .fill(totp(secret!, Math.floor(Date.now() / 30000)));
  await page.getByRole("button", { name: "验证并生成恢复码" }).click();
  await expect(
    page.getByText("请保存以下一次性恢复码，关闭后不再显示。"),
  ).toBeVisible();
  const recoveryCode = (await page.locator("pre").textContent())!
    .trim()
    .split("\n")[0];
  await page.getByRole("button", { name: "已保存，进入资料库" }).click();
  const cookie = (await page.context().cookies()).find(
    (c) => c.name === "archive_session",
  );
  expect(cookie?.path).toBe(config.basePath || "/");
  expect(cookie?.httpOnly).toBe(true);
  await expect(page.getByRole("heading", { name: "文章资料库" })).toBeVisible();
  await page.getByRole("button", { name: "公众号管理", exact: true }).click();
  await page.getByRole("button", { name: "添加公众号", exact: true }).click();
  await page.getByLabel("公众号名称").fill("验收样例 · 城市观察");
  await page.getByLabel("原始 ID", { exact: true }).fill("gh_acceptance");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加公众号", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "验收样例 · 城市观察" }),
  ).toBeVisible();
  const a = (await one(
    "SELECT * FROM accounts WHERE original_id='gh_acceptance'",
  ))!;
  const image = await sharp({
    create: { width: 240, height: 120, channels: 3, background: "#7cc8d8" },
  })
    .png()
    .toBuffer();
  const imageHash = hash(image),
    imageId = randomUUID(),
    imageUrl = "https://mmbiz.qpic.cn/acceptance-image";
  const imageKey = `assets/${a.id}/${imageHash}.png`;
  await store.put(imageKey, image, "image/png");
  await db.query(
    "INSERT INTO assets(id,account_id,hash,storage_key,mime,size) VALUES($1,$2,$3,$4,'image/png',$5)",
    [imageId, a.id, imageHash, imageKey, image.length],
  );
  const titles = [
    "一条街道的更新，从日常生活开始",
    "把春天留在社区里：我们的共创计划",
    "城市里的慢生活，还有哪些可能？",
    "六月编辑手记：持续记录的意义",
    "从一杯咖啡，认识一家社区小店",
    "周末去处｜寻找城市里的公共空间",
  ];
  for (let i = 0; i < titles.length; i++) {
    const id = randomUUID(),
      vid = randomUUID(),
      publishedAt = new Date(Date.UTC(2026, 5, 18 - i)).toISOString();
    const meta = {
      title: titles[i],
      author: i === 0 ? null : "编辑部",
      publishedAt,
      accountId: a.id,
      accountName: a.name,
      sourceUrl: `https://mp.weixin.qq.com/s/acceptance${i}`,
      articleId: id,
      archivedAt: new Date().toISOString(),
    };
    const p = prepareContent(
      `<h2>把目光放回日常</h2>${i === 0 ? `<img src="${imageUrl}" alt="验收归档图片">` : ""}<p>这是一篇用于功能验收的测试文章，并非从真实公众号下载。</p><p>街区的改变往往来自微小而持续的行动。我们走访了社区中的几位居民，记录他们对公共空间的期待。</p><blockquote>好的记录，让每一个细节都能被重新看见。</blockquote><h2>从记录到整理</h2><ul><li>观察人与空间的联系</li><li>保存原始资料与图片</li><li>在下一次更新时重新审视</li></ul>`,
    );
    const r = renderContent(p.clean, meta, [
      { url: imageUrl, assetId: imageId, hash: imageHash, ext: "png" },
    ]);
    await db.query(
      "INSERT INTO articles(id,account_id,platform_key,title,author,published_at,source_url,resource_state,tags) VALUES($1,$2,$3,$4,$5,$6,$7,'complete',$8)",
      [
        id,
        a.id,
        `fixture:${i}`,
        meta.title,
        meta.author,
        meta.publishedAt,
        meta.sourceUrl,
        i % 2 ? ["编辑手记"] : ["社区观察"],
      ],
    );
    await db.query(
      "INSERT INTO article_versions(id,article_id,content_hash,raw_key,clean_html,preview_html,markdown,plain_text,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        vid,
        id,
        hash(p.clean + id),
        `raw/fixture/${id}.html`,
        p.clean,
        r.previewHtml,
        r.markdown,
        p.plain,
        JSON.stringify(meta),
      ],
    );
    if (i === 0)
      await db.query(
        "INSERT INTO article_assets(version_id,source_url,asset_id,state) VALUES($1,$2,$3,'complete')",
        [vid, imageUrl, imageId],
      );
    await db.query("UPDATE articles SET current_version_id=$2 WHERE id=$1", [
      id,
      vid,
    ]);
  }
  await db.query(
    "UPDATE accounts SET auto_sync=false,coverage='unverified' WHERE id=$1",
    [a.id],
  );
  await page.getByRole("button", { name: "文章资料库", exact: true }).click();
  await expect(page.getByRole("heading", { name: titles[0] })).toBeVisible();
  await page.screenshot({
    path: "artifacts/library-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: titles[0] }) })
    .click();
  await expect(
    page
      .locator(".article-body")
      .getByText("这是一篇用于功能验收的测试文章，并非从真实公众号下载。", {
        exact: true,
      }),
  ).toBeVisible();
  const previewImage = page.getByAltText("验收归档图片");
  await expect(previewImage).toHaveAttribute(
    "src",
    `${config.basePath}/api/v1/assets/${imageId}`,
  );
  await expect
    .poll(() =>
      previewImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(240);
  await page.getByLabel("标签，用逗号分隔").fill("社区观察, 已复核");
  await page.getByRole("button", { name: "保存标签" }).click();
  await expect(page.getByText("标签已更新", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "artifacts/article-preview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page.getByLabel("搜索文章").fill("一条街道");
  await expect(page.locator(".article-row")).toHaveCount(1);
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.locator(".article-row")).toHaveCount(6);
  await page.getByLabel("选择本页文章").check();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "导出中心", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载 ZIP" })).toBeVisible({
    timeout: 45000,
  });
  await expect(page.getByRole("link", { name: "下载 ZIP" })).toHaveAttribute(
    "href",
    new RegExp(`^${config.basePath}/api/v1/exports/.+/download$`),
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "下载 ZIP" }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  await download.saveAs("artifacts/acceptance-export.zip");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "文章资料库", exact: true }).click();
  await expect(page.getByRole("heading", { name: titles[0] })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".sidebar")).toHaveCSS(
    "transform",
    "matrix(1, 0, 0, 1, -232, 0)",
  );
  await page.screenshot({
    path: "artifacts/library-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  if (config.basePath) {
    await page.getByRole("link", { name: "所有工具" }).click();
    await expect(
      page.getByRole("heading", { name: "钧宝工具箱" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "打开工具：文藏" }).click();
    await expect(
      page.getByRole("heading", { name: "文章资料库" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await page.getByLabel("用户名", { exact: true }).fill("acceptance");
  await page
    .getByLabel("密码", { exact: true })
    .fill("Archive-acceptance-2026!");
  await page
    .getByLabel("验证器验证码或恢复码（已启用时填写）")
    .fill(recoveryCode);
  await page.getByRole("button", { name: "登录资料库" }).click();
  await expect(page.getByRole("heading", { name: "文章资料库" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
