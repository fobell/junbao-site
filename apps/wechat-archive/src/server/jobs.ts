import { db, one, transaction, type Row } from "./db.js";
import { AppError } from "../shared/types.js";
export async function createJob(
  kind: string,
  accountId: string | null,
  userId: string | null,
  payload: Row,
  key?: string,
) {
  return transaction(async (c) => {
    if (key) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${userId}:${key}`,
      ]);
      const existing = await one(
        "SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2",
        [userId, key],
        c,
      );
      if (existing) return existing;
    }
    if (accountId) {
      await c.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        accountId,
      ]);
      if (
        await one(
          "SELECT id FROM jobs WHERE account_id=$1 AND state IN ('queued','running','paused','waiting_auth','cooldown') AND kind IN ('sync','import','repair')",
          [accountId],
          c,
        )
      )
        throw new AppError(
          "JOB_ACTIVE",
          "该公众号已有未结束任务，请在任务中心继续或取消",
          409,
        );
    }
    const job = (
      await c.query(
        "INSERT INTO jobs(kind,account_id,user_id,payload,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [kind, accountId, userId, JSON.stringify(payload), key ?? null],
      )
    ).rows[0];
    await c.query("INSERT INTO outbox(job_id) VALUES($1)", [job.id]);
    return job;
  });
}
export async function actionJob(id: string, action: string) {
  return transaction(async (c) => {
    const j = await one("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [id], c);
    if (!j) throw new AppError("NOT_FOUND", "任务不存在", 404);
    if (action === "pause") {
      if (!["queued", "running", "cooldown"].includes(j.state))
        throw new AppError("INVALID_STATE", "当前任务无法暂停", 409);
      await c.query(
        "UPDATE jobs SET state='paused',lease_id=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
    } else if (action === "cancel") {
      if (["succeeded", "cancelled"].includes(j.state))
        throw new AppError("INVALID_STATE", "任务已结束", 409);
      await c.query(
        "UPDATE jobs SET state='cancelled',lease_id=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
    } else {
      if (
        !["paused", "waiting_auth", "cooldown", "failed", "partial"].includes(
          j.state,
        )
      )
        throw new AppError("INVALID_STATE", "当前任务无法继续", 409);
      if (j.account_id) {
        await c.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
          j.account_id,
        ]);
        const other = await one(
          "SELECT id FROM jobs WHERE account_id=$1 AND id<>$2 AND state IN ('queued','running','paused','waiting_auth','cooldown')",
          [j.account_id, id],
          c,
        );
        if (other)
          throw new AppError("JOB_ACTIVE", "请先处理此账号的其他任务", 409);
      }
      await c.query(
        "UPDATE job_items SET state='pending',error=NULL WHERE job_id=$1 AND state IN ('failed','running')",
        [id],
      );
      const checkpoint = { ...j.checkpoint };
      if (["partial", "failed", "waiting_auth"].includes(j.state)) {
        checkpoint.listed = false;
        checkpoint.officialCursor = "0";
        checkpoint.officialDone = false;
        checkpoint.browserDone = false;
        checkpoint.channels = {};
      }
      await c.query(
        "UPDATE jobs SET state='queued',lease_id=NULL,error=NULL,next_run_at=NULL,attempts=0,cooldown_count=0,checkpoint=$2,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(checkpoint)],
      );
      await c.query("INSERT INTO outbox(job_id) VALUES($1)", [id]);
    }
    return { ok: true };
  });
}
export async function createExport(
  user: Row,
  ids: string[],
  idempotencyKey?: string,
) {
  return transaction(async (c) => {
    if (idempotencyKey) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${user.id}:${idempotencyKey}`,
      ]);
      const old = await one(
        "SELECT id FROM jobs WHERE user_id=$1 AND idempotency_key=$2",
        [user.id, idempotencyKey],
        c,
      );
      if (old) return old;
    }
    const articles = (
      await c.query(
        `SELECT a.*,ac.name AS account_name,ac.coverage,ac.coverage_report,v.markdown,v.metadata,v.warnings,v.archived_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceUrl',aa.source_url,'state',aa.state,'error',aa.error,'key',s.storage_key,'hash',s.hash,'mime',s.mime,'size',s.size)) FROM article_assets aa LEFT JOIN assets s ON s.id=aa.asset_id WHERE aa.version_id=v.id),'[]') AS images
      FROM articles a JOIN accounts ac ON ac.id=a.account_id JOIN article_versions v ON v.id=a.current_version_id WHERE a.id=ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    if (articles.length !== ids.length)
      throw new AppError(
        "ARTICLE_NOT_READY",
        "所选文章中存在尚未归档的正文",
        409,
      );
    if (user.role !== "admin") {
      const allowed = (
        await c.query(
          "SELECT account_id FROM account_access WHERE user_id=$1",
          [user.id],
        )
      ).rows.map((x) => x.account_id);
      if (articles.some((a) => !allowed.includes(a.account_id)))
        throw new AppError("FORBIDDEN", "包含未授权的公众号", 403);
    }
    const size = articles.reduce(
      (n, a) =>
        n +
        Buffer.byteLength(a.markdown) +
        a.images.reduce((s: number, i: any) => s + Number(i.size ?? 0), 0),
      0,
    );
    if (size > 2 * 1024 ** 3)
      throw new AppError(
        "EXPORT_TOO_LARGE",
        "预计超过 2GB，请按账号或日期分批导出",
      );
    const job = (
      await c.query(
        "INSERT INTO jobs(kind,user_id,idempotency_key) VALUES('export',$1,$2) RETURNING *",
        [user.id, idempotencyKey ?? null],
      )
    ).rows[0];
    const exp = (
      await c.query(
        "INSERT INTO exports(job_id,user_id,item_count) VALUES($1,$2,$3) RETURNING id",
        [job.id, user.id, articles.length],
      )
    ).rows[0];
    for (const article of articles)
      await c.query(
        "INSERT INTO export_items(export_id,article_id,account_id,snapshot) VALUES($1,$2,$3,$4)",
        [exp.id, article.id, article.account_id, JSON.stringify(article)],
      );
    await c.query("UPDATE jobs SET payload=$2,discovered=$3 WHERE id=$1", [
      job.id,
      JSON.stringify({ exportId: exp.id }),
      articles.length,
    ]);
    await c.query("INSERT INTO outbox(job_id) VALUES($1)", [job.id]);
    return job;
  });
}
