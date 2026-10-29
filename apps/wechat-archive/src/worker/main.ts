import { Queue, Worker } from "bullmq";
import { config, validateConfig } from "../server/config.js";
import { db, pool, transaction, one } from "../server/db.js";
import { store } from "../server/storage.js";
import { runJob } from "./runner.js";
validateConfig();
const redis = new URL(config.redisUrl);
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: redis.username || undefined,
  password: decodeURIComponent(redis.password) || undefined,
  db: Number(redis.pathname.slice(1) || 0),
  ...(redis.protocol === "rediss:" ? { tls: {} } : {}),
};
const queue = new Queue("archive", { connection });
await queue.setGlobalConcurrency(config.workerConcurrency);
const worker = new Worker("archive", async (job) => runJob(job.data.jobId), {
  connection,
  concurrency: config.workerConcurrency,
});
worker.on("error", () => console.error("Queue connection error"));
let ticking = false,
  maintenanceAt = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(40002)");
      const recovered = await c.query(
        "UPDATE jobs SET state='queued',lease_id=NULL,updated_at=now() WHERE (state='running' AND heartbeat_at<now()-interval '2 minutes') OR (state='cooldown' AND next_run_at<=now()) RETURNING id",
      );
      for (const j of recovered.rows)
        await c.query("INSERT INTO outbox(job_id) VALUES($1)", [j.id]);
      await c.query(
        "INSERT INTO outbox(job_id) SELECT j.id FROM jobs j WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.job_id=j.id AND (o.dispatched_at IS NULL OR o.dispatched_at>now()-interval '2 minutes'))",
      );
      // Each account gets a deterministic minute offset; date is persisted in PostgreSQL.
      const due = await c.query(
        "SELECT *, (now() AT TIME ZONE 'Asia/Shanghai')::date AS today FROM accounts WHERE auto_sync AND (last_scheduled_date IS NULL OR last_scheduled_date<(now() AT TIME ZONE 'Asia/Shanghai')::date) AND (now() AT TIME ZONE 'Asia/Shanghai')::time >= make_time(sync_hour,sync_minute,0) ORDER BY id FOR UPDATE",
      );
      for (const [index, a] of due.rows.entries()) {
        if (
          await one(
            "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('queued','running','paused','waiting_auth','cooldown')",
            [a.id],
            c,
          )
        )
          continue;
        if (
          !(await one(
            "SELECT 1 FROM connections WHERE account_id=$1",
            [a.id],
            c,
          ))
        )
          continue;
        const j = (
          await c.query(
            "INSERT INTO jobs(account_id,kind,payload,state,next_run_at) VALUES($1,'sync',$2,'cooldown',now()+($3::text||' seconds')::interval) RETURNING id",
            [
              a.id,
              JSON.stringify({ mode: "incremental", scheduled: true }),
              index * 60,
            ],
          )
        ).rows[0];
        await c.query(
          "UPDATE accounts SET last_scheduled_date=$2 WHERE id=$1",
          [a.id, a.today],
        );
      }
    });
    const events = (
      await db.query(
        "SELECT * FROM outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT 100",
      )
    ).rows;
    for (const event of events) {
      await queue.add(
        "execute",
        { jobId: event.job_id },
        { jobId: event.generation, removeOnComplete: 100, removeOnFail: 100 },
      );
      await db.query("UPDATE outbox SET dispatched_at=now() WHERE id=$1", [
        event.id,
      ]);
    }
    if (Date.now() - maintenanceAt > 3600000) {
      await store.cleanTemporary?.();
      for (const e of (
        await db.query(
          "SELECT id,storage_key FROM exports WHERE state='ready' AND expires_at<now() LIMIT 100",
        )
      ).rows) {
        if (e.storage_key) await store.remove(e.storage_key);
        await db.query("UPDATE exports SET state='expired' WHERE id=$1", [
          e.id,
        ]);
      }
      await db.query(
        "DELETE FROM sessions WHERE expires_at<now(); DELETE FROM audit_events WHERE created_at<now()-interval '180 days'; DELETE FROM outbox WHERE dispatched_at<now()-interval '7 days'; DELETE FROM browser_sessions WHERE expires_at<now()-interval '1 day'",
      );
      maintenanceAt = Date.now();
    }
    await db.query(
      "INSERT INTO system_status(key,value) VALUES('worker',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [
        JSON.stringify({
          healthy: true,
          queueWaiting: await queue.getWaitingCount(),
        }),
      ],
    );
  } catch {
    console.error("Scheduler or outbox unavailable; retrying in 5 seconds");
  } finally {
    ticking = false;
  }
}
const timer = setInterval(tick, 5000);
await tick();
process.on("SIGTERM", async () => {
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await pool.end();
  process.exit(0);
});
