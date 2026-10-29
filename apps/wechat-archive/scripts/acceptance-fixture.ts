// Explicitly gated fixture for isolated deployment / backup acceptance, never production seed data.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db, one, pool } from "../src/server/db.js";
import { store } from "../src/server/storage.js";
import { hash, passwordHash } from "../src/server/security.js";
import { prepareContent, renderContent } from "../src/server/content.js";
import { createExport } from "../src/server/jobs.js";
import { runJob } from "../src/worker/runner.js";
if (process.env.ALLOW_TEST_FIXTURES !== "1" || process.env.NODE_ENV !== "test")
  throw new Error(
    "This fixture is restricted to explicit isolated acceptance runs.",
  );
if (process.argv[2] === "verify") {
  const article = await one(
    "SELECT a.*,v.preview_html FROM articles a JOIN article_versions v ON v.id=a.current_version_id WHERE title='备份恢复验收样例'",
  );
  if (!article || !article.preview_html.includes("/api/v1/assets/"))
    throw new Error("Restored article missing");
  for (const asset of (
    await db.query("SELECT * FROM assets WHERE account_id=$1", [
      article.account_id,
    ])
  ).rows)
    if ((await store.size(asset.storage_key)) !== Number(asset.size))
      throw new Error("Restored image missing");
  const user = (await one(
    "SELECT * FROM users WHERE username='backup_acceptance'",
  ))!;
  const job = await createExport(user, [article.id]);
  await runJob(job.id);
  const e = await one("SELECT * FROM exports WHERE job_id=$1", [job.id]);
  if (e?.state !== "ready") throw new Error("Restored export failed");
  console.log(
    JSON.stringify({
      restoredArticle: true,
      restoredImage: true,
      newExport: true,
      bytes: e.size,
    }),
  );
} else {
  if (await one("SELECT 1 FROM accounts LIMIT 1"))
    throw new Error("Fixture requires an empty application database.");
  const account = (
    await db.query(
      "INSERT INTO accounts(name,original_id,auto_sync) VALUES('备份验收样例','gh_backupAcceptance',false) RETURNING *",
    )
  ).rows[0];
  await db.query(
    "INSERT INTO users(username,display_name,password_hash,role) VALUES('backup_acceptance','验收样例',$1,'admin')",
    [await passwordHash(randomUUID())],
  );
  const image = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#18735c" },
  })
    .png()
    .toBuffer();
  const digest = hash(image),
    assetId = randomUUID(),
    key = `assets/${account.id}/${digest}.png`;
  await store.put(key, image, "image/png");
  await db.query(
    "INSERT INTO assets(id,account_id,hash,storage_key,mime,size) VALUES($1,$2,$3,$4,$5,$6)",
    [assetId, account.id, digest, key, "image/png", image.length],
  );
  const id = randomUUID(),
    vid = randomUUID(),
    url = "https://mmbiz.qpic.cn/acceptance-image";
  const raw = `<h2>备份验收正文</h2><p>此为隔离环境中的测试数据。</p><img src="${url}">`;
  const p = prepareContent(raw);
  const metadata = {
    title: "备份恢复验收样例",
    author: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    accountId: account.id,
    accountName: account.name,
    sourceUrl: "https://mp.weixin.qq.com/s/acceptance",
    articleId: id,
    archivedAt: new Date().toISOString(),
  };
  const rendered = renderContent(p.clean, metadata, [
    { url, assetId, hash: digest, ext: "png" },
  ]);
  const rawKey = `raw/${account.id}/${id}.html`;
  await store.put(rawKey, Buffer.from(raw), "text/html");
  await db.query(
    "INSERT INTO articles(id,account_id,platform_key,title,source_url,resource_state) VALUES($1,$2,'fixture',$3,$4,'complete')",
    [id, account.id, metadata.title, metadata.sourceUrl],
  );
  await db.query(
    "INSERT INTO article_versions(id,article_id,content_hash,raw_key,clean_html,preview_html,markdown,plain_text,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      vid,
      id,
      hash(raw),
      rawKey,
      p.clean,
      rendered.previewHtml,
      rendered.markdown,
      p.plain,
      JSON.stringify(metadata),
    ],
  );
  await db.query(
    "INSERT INTO article_assets(version_id,source_url,asset_id,state) VALUES($1,$2,$3,'complete')",
    [vid, url, assetId],
  );
  await db.query("UPDATE articles SET current_version_id=$2 WHERE id=$1", [
    id,
    vid,
  ]);
  console.log(
    "Isolated fixture created; no real WeChat articles or credentials are used.",
  );
}
await pool.end();
