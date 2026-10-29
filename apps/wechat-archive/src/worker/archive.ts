import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db, one, transaction, type Row } from "../server/db.js";
import { config } from "../server/config.js";
import { safeFetch } from "../server/network.js";
import { hash } from "../server/security.js";
import {
  extractPage,
  prepareContent,
  renderContent,
  imageType,
  type Metadata,
  type ImageResult,
} from "../server/content.js";
import { store } from "../server/storage.js";
import { AppError, type ArticleRef } from "../shared/types.js";
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (n >= 3 || (e instanceof AppError && !e.retryable)) throw e;
      await delay(Math.min(8000, 1000 * 2 ** n));
    }
  }
}
export function errorText(e: unknown) {
  return e instanceof AppError
    ? `${e.code}: ${e.message}`
    : "NETWORK_OR_STORAGE_ERROR: 网络、数据库或存储暂不可用";
}
export async function repairImages(
  article: Row,
  version: Row,
  check: () => Promise<void>,
) {
  const urls = (
    await db.query(
      "SELECT source_url FROM article_assets WHERE version_id=$1",
      [version.id],
    )
  ).rows.map((r) => r.source_url as string);
  let offset = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, urls.length) }, async () => {
      while (offset < urls.length) {
        const url = urls[offset++];
        await check();
        const existing = await one(
          "SELECT aa.*,s.storage_key,s.hash,s.mime FROM article_assets aa LEFT JOIN assets s ON s.id=aa.asset_id WHERE version_id=$1 AND source_url=$2",
          [version.id, url],
        );
        if (existing?.state === "complete" && existing.storage_key) {
          try {
            await store.size(existing.storage_key);
            continue;
          } catch {}
        }
        try {
          const r = await retry(() =>
            safeFetch(url, "image", { maxBytes: config.maxImageBytes }),
          );
          const type = imageType(r.body);
          if (!type || r.body.length < 16)
            throw new AppError(
              "INVALID_IMAGE",
              "图片类型或文件内容不正确",
              422,
            );
          await sharp(r.body, {
            limitInputPixels: 40000000,
            failOn: "warning",
          }).stats();
          const digest = hash(r.body);
          const key = `assets/${article.account_id}/${digest}.${type.ext}`;
          await store.put(key, r.body, type.mime);
          await check();
          const asset = (
            await db.query(
              "INSERT INTO assets(account_id,hash,storage_key,mime,size) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,hash) DO UPDATE SET storage_key=EXCLUDED.storage_key RETURNING id",
              [article.account_id, digest, key, type.mime, r.body.length],
            )
          ).rows[0];
          await db.query(
            "UPDATE article_assets SET state='complete',asset_id=$3,error=NULL WHERE version_id=$1 AND source_url=$2",
            [version.id, url, asset.id],
          );
        } catch (e) {
          if (e instanceof AppError && e.code === "STOPPED") throw e;
          await db.query(
            "UPDATE article_assets SET state='missing',asset_id=NULL,error=$3 WHERE version_id=$1 AND source_url=$2",
            [version.id, url, errorText(e)],
          );
        }
      }
    }),
  );
  const rows = (
    await db.query(
      "SELECT aa.*,s.hash,s.mime FROM article_assets aa LEFT JOIN assets s ON s.id=aa.asset_id WHERE version_id=$1",
      [version.id],
    )
  ).rows;
  const images: ImageResult[] = rows.map((r) => ({
    url: r.source_url,
    assetId: r.asset_id ?? undefined,
    hash: r.hash,
    ext: extension(r.mime),
    error: r.error,
  }));
  const rendered = renderContent(
    version.clean_html,
    version.metadata,
    images,
    version.warnings,
  );
  const missing =
    rows.some((r) => r.state !== "complete") ||
    version.warnings.some((x: string) => x.includes("不受支持的图片"));
  await check();
  await transaction(async (c) => {
    await c.query(
      "UPDATE article_versions SET markdown=$2,preview_html=$3 WHERE id=$1",
      [version.id, rendered.markdown, rendered.previewHtml],
    );
    await c.query(
      "UPDATE articles SET resource_state=$2,last_error=NULL WHERE id=$1 AND current_version_id=$3",
      [article.id, missing ? "missing" : "complete", version.id],
    );
  });
  return missing;
}
export function extension(mime: string) {
  return (
    (
      {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
      } as Record<string, string>
    )[mime] ?? "bin"
  );
}
export async function archiveArticle(
  account: Row,
  ref: ArticleRef,
  check: () => Promise<void>,
) {
  await check();
  let old = await one(
    "SELECT a.* FROM articles a WHERE account_id=$1 AND (platform_key=$2 OR source_url=$3 OR id IN (SELECT article_id FROM article_sources WHERE account_id=$1 AND source=$4 AND source_id=$5)) LIMIT 1",
    [account.id, ref.key, ref.url, ref.source, ref.sourceId],
  );
  if (ref.deleted) {
    if (old) {
      await db.query("UPDATE articles SET source_state='deleted' WHERE id=$1", [
        old.id,
      ]);
      return { articleId: old.id, missing: old.resource_state !== "complete" };
    }
    throw new AppError(
      "ARTICLE_DELETED",
      "源文章已删除且没有可用的历史存档",
      422,
    );
  }
  let raw = ref.html,
    title = ref.title,
    author = ref.author ?? null,
    publishedAt = ref.publishedAt ?? null,
    biz = ref.biz,
    key = ref.key;
  if (!raw || ref.source === "url" || (!biz && !account.skipPageEnrichment)) {
    try {
      const r = await retry(() => safeFetch(ref.url, "article"));
      const page = extractPage(r.body.toString(), r.url);
      if (
        ref.source === "url" &&
        !(
          (account.biz && account.biz === page.biz) ||
          (page.originalId && account.original_id === page.originalId)
        )
      )
        throw new AppError(
          "ACCOUNT_IDENTITY_UNKNOWN",
          "此链接无法确认属于已连接的公众号，请先完成该账号的清单同步",
          409,
        );
      if (account.biz && page.biz && account.biz !== page.biz)
        throw new AppError(
          "ACCOUNT_MISMATCH",
          "文章所属公众号与当前账号不一致",
          409,
        );
      raw = raw || page.html;
      title = page.title || title;
      author = author || page.author;
      publishedAt = publishedAt || page.publishedAt;
      biz = biz || page.biz;
      key = page.platformKey || key;
    } catch (e) {
      if (
        raw &&
        e instanceof AppError &&
        ["RATE_LIMIT", "VERIFICATION_REQUIRED"].includes(e.code)
      )
        account.skipPageEnrichment = true;
      if (
        !raw ||
        (e instanceof AppError &&
          ["ACCOUNT_MISMATCH", "ACCOUNT_IDENTITY_UNKNOWN"].includes(e.code))
      ) {
        if (old && e instanceof AppError && e.code === "ARTICLE_UNAVAILABLE")
          await db.query(
            "UPDATE articles SET source_state='unavailable',last_error=$2 WHERE id=$1",
            [old.id, e.message],
          );
        throw e;
      }
    }
  }
  if (!raw) throw new AppError("EMPTY_CONTENT", "未获取到正文", 422);
  publishedAt = publishedAt ?? old?.published_at?.toISOString() ?? null;
  if (account.biz && biz && account.biz !== biz)
    throw new AppError("ACCOUNT_MISMATCH", "文章账号标识不匹配", 409);
  if (biz && !account.biz && ref.source !== "url") {
    await db.query("UPDATE accounts SET biz=$2 WHERE id=$1 AND biz IS NULL", [
      account.id,
      biz,
    ]);
    account.biz = biz;
  }
  const prepared = prepareContent(raw);
  const contentHash = hash(
    JSON.stringify({ html: prepared.clean, title, author, publishedAt }),
  );
  old =
    old ||
    (await one(
      "SELECT * FROM articles WHERE account_id=$1 AND platform_key=$2",
      [account.id, key],
    ));
  const id = old?.id ?? randomUUID();
  const versionId = randomUUID();
  const archivedAt = new Date().toISOString();
  const metadata: Metadata = {
    title,
    author,
    publishedAt,
    accountName: account.name,
    accountId: account.id,
    sourceUrl: ref.url,
    articleId: id,
    archivedAt,
  };
  const rawKey = `raw/${account.id}/${id}/${hash(raw)}.html`;
  await store.put(rawKey, Buffer.from(raw), "text/html; charset=utf-8");
  await check();
  const version = await transaction(async (c) => {
    await c.query(
      "INSERT INTO articles(id,account_id,platform_key,title,author,published_at,source_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET title=$4,author=$5,published_at=COALESCE($6,articles.published_at),source_state='available',updated_at=now()",
      [id, account.id, key, title, author, publishedAt, ref.url],
    );
    const v = (
      await c.query(
        "INSERT INTO article_versions(id,article_id,content_hash,raw_key,clean_html,preview_html,markdown,plain_text,metadata,warnings) VALUES($1,$2,$3,$4,$5,'','',$6,$7,$8) ON CONFLICT(article_id,content_hash) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING *",
        [
          versionId,
          id,
          contentHash,
          rawKey,
          prepared.clean,
          prepared.plain,
          JSON.stringify(metadata),
          JSON.stringify(prepared.warnings),
        ],
      )
    ).rows[0];
    for (const url of prepared.images)
      await c.query(
        "INSERT INTO article_assets(version_id,source_url) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [v.id, url],
      );
    await c.query("UPDATE articles SET current_version_id=$2 WHERE id=$1", [
      id,
      v.id,
    ]);
    await c.query(
      "INSERT INTO article_sources(article_id,account_id,source,source_id,source_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source,source_id) DO UPDATE SET article_id=EXCLUDED.article_id,source_url=EXCLUDED.source_url",
      [id, account.id, ref.source, ref.sourceId, ref.url],
    );
    return v;
  });
  const missing = await repairImages(
    { id, account_id: account.id },
    version,
    check,
  );
  return { articleId: id, missing };
}
