import { randomUUID } from "node:crypto";
import { db, one, transaction, pool, type Row } from "../server/db.js";
import { config } from "../server/config.js";
import {
  OfficialApiAdapter,
  BackendBrowserAdapter,
  ArticleUrlAdapter,
  browserCall,
} from "../server/sources.js";
import { AppError, type ArticleRef, type SourcePage } from "../shared/types.js";
import {
  archiveArticle,
  repairImages,
  retry,
  delay,
  errorText,
} from "./archive.js";
import { exportJob } from "./export.js";
export async function ingest(jobId: string, page: SourcePage) {
  await transaction(async (c) => {
    for (const ref of page.items) {
      const prev = await one(
        "SELECT ref FROM job_items WHERE job_id=$1 AND item_key=$2",
        [jobId, ref.key],
        c,
      );
      const sources = [
        ...new Map(
          [
            ...(prev?.ref.sources ?? []),
            { source: ref.source, sourceId: ref.sourceId, url: ref.url },
          ].map((s) => [`${s.source}:${s.sourceId}`, s]),
        ).values(),
      ];
      const merged = {
        ...ref,
        ...(prev?.ref ?? {}),
        publishedAt: ref.publishedAt || prev?.ref.publishedAt,
        html: ref.html || prev?.ref.html,
        sources,
      };
      await c.query(
        "INSERT INTO job_items(job_id,item_key,ref) VALUES($1,$2,$3) ON CONFLICT(job_id,item_key) DO UPDATE SET ref=EXCLUDED.ref",
        [jobId, ref.key, JSON.stringify(merged)],
      );
    }
    await c.query(
      "UPDATE jobs SET discovered=(SELECT count(*) FROM job_items WHERE job_id=$1) WHERE id=$1",
      [jobId],
    );
  });
}
async function synchronize(job: Row, check: () => Promise<void>) {
  const account = (await one("SELECT * FROM accounts WHERE id=$1", [
    job.account_id,
  ]))!;
  const cp = job.checkpoint;
  const channels: Row = cp.channels ?? {};
  async function checkpoint() {
    cp.channels = channels;
    await check();
    await db.query(
      "UPDATE jobs SET checkpoint=$3 WHERE id=$1 AND lease_id=$2",
      [job.id, job.lease_id, JSON.stringify(cp)],
    );
  }
  if (job.kind === "repair") {
    const article = await one(
      "SELECT * FROM articles WHERE id=$1 AND account_id=$2",
      [job.payload.articleId, account.id],
    );
    if (!article) throw new AppError("NOT_FOUND", "文章不存在");
    let missing = false;
    if (job.payload.refetch) {
      const source = await one(
        "SELECT * FROM article_sources WHERE article_id=$1 ORDER BY source LIMIT 1",
        [article.id],
      );
      const result = await archiveArticle(
        account,
        {
          key: article.platform_key,
          url: article.source_url,
          title: article.title,
          source: source?.source ?? "url",
          sourceId: source?.source_id ?? article.platform_key,
          publishedAt: article.published_at?.toISOString(),
          author: article.author,
        },
        check,
      );
      missing = result.missing;
    } else {
      const v = await one("SELECT * FROM article_versions WHERE id=$1", [
        article.current_version_id,
      ]);
      if (!v) throw new AppError("EMPTY_CONTENT", "正文尚未归档，请重新获取");
      missing = await repairImages(article, v, check);
    }
    await db.query("UPDATE jobs SET processed=1,discovered=1 WHERE id=$1", [
      job.id,
    ]);
    return {
      state: missing ? "partial" : "succeeded",
      report: { missingImages: missing },
    };
  }
  if (!cp.listed) {
    await db.query("UPDATE jobs SET phase='获取与核对清单' WHERE id=$1", [
      job.id,
    ]);
    if (job.kind === "import") {
      await ingest(
        job.id,
        await new ArticleUrlAdapter(job.payload.urls).list(),
      );
    } else {
      const connections = (
        await db.query(
          "SELECT kind,status FROM connections WHERE account_id=$1",
          [account.id],
        )
      ).rows;
      if (connections.some((c) => c.kind === "official") && !cp.officialDone) {
        try {
          const adapter = new OfficialApiAdapter(account);
          let cursor = cp.officialCursor ?? "0";
          for (let n = 0; n < 10000; n++) {
            await check();
            const page = await retry(() => adapter.list(cursor));
            await ingest(job.id, page);
            channels.official = {
              ok: true,
              articleCount:
                (channels.official?.articleCount ?? 0) + page.items.length,
              messageTotal: page.totalMessages,
            };
            cp.officialCursor = page.cursor;
            cp.officialDone = page.ended;
            await checkpoint();
            if (page.ended) break;
            if (page.cursor === cursor)
              throw new AppError("LIST_REPEATED", "官方分页没有推进");
            cursor = page.cursor!;
            await delay(config.requestDelay);
          }
        } catch (e) {
          if (
            e instanceof AppError &&
            ["STOPPED", "RATE_LIMIT"].includes(e.code)
          )
            throw e;
          channels.official = { ok: false, error: errorText(e) };
          await db.query(
            "UPDATE connections SET status='error',last_error=$2 WHERE account_id=$1 AND kind='official'",
            [account.id, errorText(e)],
          );
        }
      }
      if (connections.some((c) => c.kind === "browser") && !cp.browserDone) {
        try {
          await check();
          const page = await retry(() =>
            new BackendBrowserAdapter(account, job.lease_id, check).list(),
          );
          await ingest(job.id, page);
          channels.browser = {
            ok: true,
            reconciled:
              page.ended && page.evidence === "backend_count_reconciled",
            articleCount: page.items.length,
            messageTotal: page.totalMessages,
          };
          cp.browserDone = true;
        } catch (e) {
          if (
            e instanceof AppError &&
            ["STOPPED", "RATE_LIMIT"].includes(e.code)
          )
            throw e;
          channels.browser = { ok: false, error: errorText(e) };
          await db.query(
            "UPDATE connections SET status='error',last_error=$2 WHERE account_id=$1 AND kind='browser'",
            [account.id, errorText(e)],
          );
        }
      }
      if (!connections.length)
        throw new AppError("AUTH_EXPIRED", "请配置官方接口或扫码连接后台", 409);
    }
    cp.listed = true;
    await checkpoint();
  }
  await db.query("UPDATE jobs SET phase='归档正文与图片' WHERE id=$1", [
    job.id,
  ]);
  await db.query(
    "UPDATE job_items SET state='pending' WHERE job_id=$1 AND state='running'",
    [job.id],
  );
  while (true) {
    await check();
    const item = await one(
      "SELECT * FROM job_items WHERE job_id=$1 AND state='pending' ORDER BY id LIMIT 1",
      [job.id],
    );
    if (!item) break;
    await db.query("UPDATE job_items SET state='running' WHERE id=$1", [
      item.id,
    ]);
    try {
      const ref = item.ref as ArticleRef;
      const old = await one(
        "SELECT * FROM articles WHERE account_id=$1 AND platform_key=$2",
        [account.id, ref.key],
      );
      let result;
      if (
        job.payload.mode === "incremental" &&
        old?.current_version_id &&
        old.resource_state === "complete" &&
        old.published_at &&
        new Date(old.published_at).getTime() < Date.now() - 30 * 86400000 &&
        !ref.deleted
      ) {
        result = { articleId: old.id, missing: false };
      } else result = await archiveArticle(account, ref, check);
      for (const s of item.ref.sources ?? [])
        await db.query(
          "INSERT INTO article_sources(account_id,article_id,source,source_id,source_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source,source_id) DO UPDATE SET article_id=EXCLUDED.article_id",
          [account.id, result.articleId, s.source, s.sourceId, s.url],
        );
      await db.query(
        "UPDATE job_items SET state='done',article_id=$2,error=$3 WHERE id=$1",
        [
          item.id,
          result.articleId,
          result.missing ? "存在缺失图片，可在文章详情单独重试" : null,
        ],
      );
    } catch (e) {
      if (
        e instanceof AppError &&
        [
          "STOPPED",
          "RATE_LIMIT",
          "AUTH_EXPIRED",
          "VERIFICATION_REQUIRED",
        ].includes(e.code)
      ) {
        await db.query("UPDATE job_items SET state='pending' WHERE id=$1", [
          item.id,
        ]);
        throw e;
      }
      await db.query(
        "UPDATE job_items SET state='failed',error=$2 WHERE id=$1",
        [item.id, errorText(e)],
      );
    }
    await db.query(
      "UPDATE jobs SET processed=(SELECT count(*) FROM job_items WHERE job_id=$1 AND state='done'),failed=(SELECT count(*) FROM job_items WHERE job_id=$1 AND state='failed') WHERE id=$1",
      [job.id],
    );
    await delay(config.requestDelay);
  }
  const totals = (await one(
    "SELECT count(*)::int AS discovered,count(*) FILTER(WHERE state='done')::int AS successful,count(*) FILTER(WHERE state='failed')::int AS failed,count(*) FILTER(WHERE state='done' AND error IS NOT NULL)::int AS missing FROM job_items WHERE job_id=$1",
    [job.id],
  ))!;
  const sourceErrors = Object.values(channels).some((c: any) => !c.ok);
  let coverage = account.coverage;
  if (job.kind === "sync") {
    // Browser count evidence alone does not establish coverage of all official entries.
    const officialOnly = Number(
      (
        await one(
          "SELECT count(*)::int AS n FROM job_items WHERE job_id=$1 AND ref->>'source'='official' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ref->'sources') s WHERE s->>'source'='browser')",
          [job.id],
        )
      )?.n ?? 0,
    );
    coverage =
      channels.browser?.reconciled && !officialOnly
        ? "verified"
        : officialOnly
          ? "has_gaps"
          : "unverified";
    await db.query(
      "UPDATE accounts SET coverage=$2,coverage_checked_at=now(),coverage_report=$3,last_synced_at=now() WHERE id=$1",
      [
        account.id,
        coverage,
        JSON.stringify({ channels, officialOnly, ...totals }),
      ],
    );
  }
  const report = {
    channels,
    ...totals,
    historyCoverage: coverage,
    complete: coverage === "verified" && !totals.failed && !totals.missing,
  };
  if (!totals.discovered && sourceErrors)
    return { state: "waiting_auth", report };
  return {
    state:
      totals.failed || totals.missing || sourceErrors ? "partial" : "succeeded",
    report,
  };
}
export async function runJob(id: string) {
  const lock = await pool.connect();
  let locked = false,
    accountId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const existing = await one("SELECT * FROM jobs WHERE id=$1", [id]);
    if (!existing || existing.state !== "queued") return;
    accountId = existing.account_id;
    const lockKey = accountId ?? id;
    locked = (
      await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
        `job:${lockKey}`,
      ])
    ).rows[0].ok;
    if (!locked) return;
    const lease = randomUUID();
    const job = await one(
      "UPDATE jobs SET state='running',lease_id=$2,heartbeat_at=now(),updated_at=now(),error=NULL,processed=CASE WHEN kind='export' THEN 0 ELSE processed END WHERE id=$1 AND state='queued' RETURNING *",
      [id, lease],
    );
    if (!job) return;
    const check = async () => {
      if (
        !(await one(
          "SELECT 1 FROM jobs WHERE id=$1 AND lease_id=$2 AND state='running'",
          [id, lease],
        ))
      )
        throw new AppError("STOPPED", "任务已停止");
    };
    heartbeat = setInterval(() => {
      db.query(
        "UPDATE jobs SET heartbeat_at=now() WHERE id=$1 AND lease_id=$2",
        [id, lease],
      )
        .then(async (result) => {
          if (!result.rowCount)
            await browserCall(`/scans/${lease}/cancel`, {}).catch(() => {});
        })
        .catch(() => {});
    }, 10000);
    try {
      const result =
        job.kind === "export"
          ? await exportJob(job, check)
          : await synchronize(job, check);
      await check();
      await db.query(
        "UPDATE jobs SET state=$3,report=$4,phase='处理结束',lease_id=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2",
        [id, lease, result.state, JSON.stringify(result.report)],
      );
    } catch (e) {
      if (e instanceof AppError && e.code === "STOPPED") return;
      let state = "failed";
      let next: Date | null = null;
      if (
        e instanceof AppError &&
        ["AUTH_EXPIRED", "VERIFICATION_REQUIRED", "ACCOUNT_MISMATCH"].includes(
          e.code,
        )
      )
        state = "waiting_auth";
      if (e instanceof AppError && e.code === "RATE_LIMIT") {
        state = job.cooldown_count < 1 ? "cooldown" : "waiting_auth";
        next =
          state === "cooldown"
            ? new Date(Date.now() + Math.max(1800000, e.retryAfterMs ?? 0))
            : null;
      }
      await db.query(
        "UPDATE jobs SET state=$3,error=$4,lease_id=NULL,next_run_at=$5,cooldown_count=cooldown_count+$6,updated_at=now() WHERE id=$1 AND lease_id=$2",
        [
          id,
          lease,
          state,
          errorText(e),
          next,
          e instanceof AppError && e.code === "RATE_LIMIT" ? 1 : 0,
        ],
      );
      if (job.kind === "export")
        await db.query("UPDATE exports SET state='failed' WHERE job_id=$1", [
          id,
        ]);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked)
      await lock
        .query("SELECT pg_advisory_unlock(hashtext($1))", [
          `job:${accountId ?? id}`,
        ])
        .catch(() => {});
    lock.release();
  }
}
