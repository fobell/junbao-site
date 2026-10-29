import archiver from "archiver";
import { PassThrough, Readable } from "node:stream";
import { db, one, type Row } from "../server/db.js";
import { store } from "../server/storage.js";
import { csvCell, safeFilename } from "../server/security.js";
import { extension } from "./archive.js";
import { AppError } from "../shared/types.js";
export function exportFolder(a: Row) {
  return `accounts/${safeFilename(a.account_name)}_${a.account_id}/${String(a.metadata.publishedAt ?? "undated").slice(0, 10)}_${a.id}_${safeFilename(a.metadata.title)}`;
}
export async function exportJob(job: Row, check: () => Promise<void>) {
  const exp = await one("SELECT * FROM exports WHERE job_id=$1", [job.id]);
  if (!exp) throw new Error("Export missing");
  const rows = (
    await db.query(
      "SELECT snapshot FROM export_items WHERE export_id=$1 ORDER BY article_id",
      [exp.id],
    )
  ).rows.map((r) => r.snapshot);
  const manifest: any = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    articles: [],
    historyScope: "所选文章的版本快照；账号历史覆盖见各条记录",
  };
  const zip = archiver("zip", { zlib: { level: 6 } });
  const stream = new PassThrough();
  zip.pipe(stream);
  zip.on("error", (e) => stream.destroy(e));
  zip.on("warning", (e) => stream.destroy(e));
  let uploadError: unknown;
  const key = `exports/${exp.id}/${job.lease_id}.zip`;
  const upload = store.put(key, stream, "application/zip").catch((e) => {
    uploadError = e;
    zip.abort();
    stream.destroy();
  });
  const csv = [
    [
      "公众号",
      "文章ID",
      "标题",
      "作者",
      "发布时间",
      "原文链接",
      "历史覆盖",
      "图片状态",
      "文件",
    ]
      .map(csvCell)
      .join(","),
  ];
  try {
    for (const a of rows) {
      await check();
      if (uploadError) throw uploadError;
      const folder = exportFolder(a);
      zip.append(a.markdown, { name: `${folder}/article.md` });
      const seen = new Set<string>();
      for (const image of a.images) {
        if (image.state !== "complete") continue;
        if (seen.has(image.hash)) continue;
        seen.add(image.hash);
        const input = Readable.from(
          (async function* () {
            await check();
            const source = await store.get(image.key);
            try {
              for await (const chunk of source) yield chunk;
            } finally {
              source.destroy();
            }
          })(),
        );
        input.on("error", (e) => stream.destroy(e));
        zip.append(input, {
          name: `${folder}/images/${image.hash}.${extension(image.mime)}`,
        });
      }
      const entry = {
        id: a.id,
        versionId: a.current_version_id,
        accountId: a.account_id,
        account: a.account_name,
        title: a.metadata.title,
        author: a.metadata.author,
        publishedAt: a.metadata.publishedAt,
        source: a.metadata.sourceUrl,
        archivedAt: a.archived_at,
        historyCoverage: a.coverage,
        resourceState: a.resource_state,
        complete: a.coverage === "verified" && a.resource_state === "complete",
        warnings: a.warnings,
        missingImages: a.images
          .filter((i: any) => i.state !== "complete")
          .map((i: any) => ({ url: i.sourceUrl, error: i.error })),
        file: `${folder}/article.md`,
      };
      manifest.articles.push(entry);
      csv.push(
        [
          entry.account,
          entry.id,
          entry.title,
          entry.author ?? "",
          entry.publishedAt ?? "",
          entry.source,
          entry.historyCoverage,
          entry.resourceState,
          entry.file,
        ]
          .map(csvCell)
          .join(","),
      );
      await db.query(
        "UPDATE jobs SET processed=processed+1 WHERE id=$1 AND lease_id=$2",
        [job.id, job.lease_id],
      );
    }
    manifest.complete = manifest.articles.every((a: any) => a.complete);
    zip.append("\uFEFF" + csv.join("\r\n"), { name: "index.csv" });
    zip.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    await zip.finalize();
    await upload;
    if (uploadError) throw uploadError;
    await check();
    const size = await store.size(key);
    if (size > 2 * 1024 ** 3)
      throw new AppError("EXPORT_TOO_LARGE", "导出包超过 2GB，请分批导出");
    await db.query(
      "UPDATE exports SET state='ready',storage_key=$2,size=$3,manifest=$4,expires_at=now()+interval '7 days' WHERE id=$1",
      [exp.id, key, size, JSON.stringify(manifest)],
    );
    return {
      state: "succeeded",
      report: {
        exportId: exp.id,
        complete: manifest.complete,
        count: rows.length,
      },
    };
  } catch (e) {
    zip.abort();
    stream.destroy();
    await upload;
    await store.remove(key).catch(() => {});
    throw e;
  }
}
