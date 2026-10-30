import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { config } from "../src/server/config.js";
import { db, one, pool } from "../src/server/db.js";
import { buildApp } from "../src/server/api.js";
import { hash, passwordHash, totp, seal } from "../src/server/security.js";
import { archiveArticle, repairImages } from "../src/worker/archive.js";
import { createJob, createExport, actionJob } from "../src/server/jobs.js";
import { runJob } from "../src/worker/runner.js";
import { store } from "../src/server/storage.js";
import { safeFetch } from "../src/server/network.js";
import {
  OfficialApiAdapter,
  BackendBrowserAdapter,
} from "../src/server/sources.js";
import { AppError, type ArticleRef } from "../src/shared/types.js";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
vi.mock("../src/server/network.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/network.js")>()),
  safeFetch: vi.fn(),
}));
const integration =
  process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;
integration(
  "PostgreSQL + API + archive + export integration (isolated fixtures)",
  () => {
    let app: Awaited<ReturnType<typeof buildApp>>,
      adminId: string,
      operatorId: string,
      account: any,
      other: any,
      headers: any,
      opHeaders: any,
      image: Buffer,
      articleId: string;
    beforeAll(async () => {
      if (
        !/^postgres:\/\/archive:archive@(127\.0\.0\.1|host\.docker\.internal):25432\/archive$/.test(
          config.databaseUrl,
        )
      )
        throw new Error(
          "Integration tests require the isolated database on port 25432",
        );
      if (config.storageDriver === "s3") {
        const client = new S3Client({
          endpoint: config.s3Endpoint,
          region: config.s3Region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.s3AccessKey,
            secretAccessKey: config.s3Secret,
          },
        });
        await client
          .send(new CreateBucketCommand({ Bucket: config.s3Bucket }))
          .catch((e: any) => {
            if (
              !["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(
                e.name,
              )
            )
              throw e;
          });
        client.destroy();
      }
      await db.query("TRUNCATE users,accounts,system_status CASCADE");
      app = await buildApp();
      const ph = await passwordHash("test-password-2026");
      adminId = (
        await db.query(
          "INSERT INTO users(username,display_name,password_hash,role,totp_enabled) VALUES('admin','测试管理员',$1,'admin',true) RETURNING id",
          [ph],
        )
      ).rows[0].id;
      operatorId = (
        await db.query(
          "INSERT INTO users(username,display_name,password_hash,role) VALUES('operator','测试运营',$1,'operator') RETURNING id",
          [ph],
        )
      ).rows[0].id;
      const session = async (id: string) => {
        const token = randomUUID(),
          csrf = randomUUID();
        await db.query(
          "INSERT INTO sessions(id_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
          [hash(token), id, csrf],
        );
        return {
          cookie: `archive_session=${token}`,
          origin: config.origin,
          "x-csrf-token": csrf,
        };
      };
      headers = await session(adminId);
      opHeaders = await session(operatorId);
      account = (
        await db.query(
          "INSERT INTO accounts(name,original_id,biz,auto_sync) VALUES('验收测试账号 A','gh_testA','BIZA',false) RETURNING *",
        )
      ).rows[0];
      other = (
        await db.query(
          "INSERT INTO accounts(name,original_id,biz,auto_sync) VALUES('验收测试账号 B','gh_testB','BIZB',false) RETURNING *",
        )
      ).rows[0];
      await db.query("INSERT INTO account_access VALUES($1,$2)", [
        operatorId,
        account.id,
      ]);
      image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#18735c" },
      })
        .png()
        .toBuffer();
    });
    afterAll(async () => {
      await app?.close();
      await pool.end();
    });
    const ref: ArticleRef = {
      key: "BIZA:100:1",
      url: "https://mp.weixin.qq.com/s?__biz=BIZA&mid=100&idx=1",
      title: "中文归档测试",
      author: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      source: "official",
      sourceId: "official-1",
      biz: "BIZA",
      html: '<h2>完整正文</h2><p>中文搜索关键字：归档测试</p><img data-src="https://mmbiz.qpic.cn/test-image">',
    };
    it("enforces authentication, CSRF, admin and account scopes", async () => {
      expect((await app.inject("/api/v1/accounts")).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/accounts/${account.id}/sync-jobs`,
            headers: { cookie: headers.cookie },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/accounts/${other.id}/sync-jobs`,
            headers: opHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: "/api/v1/users", headers: opHeaders }))
          .statusCode,
      ).toBe(403);
      const list = (
        await app.inject({ url: "/api/v1/accounts", headers: opHeaders })
      ).json();
      expect(list.items.map((a: any) => a.id)).toEqual([account.id]);
    });
    it("archives and deduplicates a repeated article and local images", async () => {
      vi.mocked(safeFetch).mockResolvedValue({
        body: image,
        mime: "image/png",
        status: 200,
        url: "https://mmbiz.qpic.cn/test-image",
      });
      const first = await archiveArticle(account, ref, async () => {});
      articleId = first.articleId;
      expect(first.missing).toBe(false);
      expect(
        (await archiveArticle(account, ref, async () => {})).articleId,
      ).toBe(articleId);
      expect(
        (await one(
          "SELECT count(*)::int AS n FROM article_versions WHERE article_id=$1",
          [articleId],
        ))!.n,
      ).toBe(1);
      const a = await one("SELECT * FROM articles WHERE id=$1", [articleId]);
      expect(a!.resource_state).toBe("complete");
    });
    it("projects stored preview assets into the public path without changing the database", async () => {
      const before = (await one(
        "SELECT preview_html FROM article_versions WHERE article_id=$1",
        [articleId],
      ))!.preview_html;
      const response = await app.inject({
        url: `/api/v1/articles/${articleId}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().version.preview_html).toContain(
        `src="${config.basePath}/api/v1/assets/`,
      );
      expect(
        (await one(
          "SELECT preview_html FROM article_versions WHERE article_id=$1",
          [articleId],
        ))!.preview_html,
      ).toBe(before);
    });
    it("scopes login and logout cookies while preserving origin and CSRF checks", async () => {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: config.origin },
        payload: { username: "operator", password: "test-password-2026" },
      });
      expect(login.statusCode).toBe(200);
      const live = login.cookies.find(
        (c) => c.name === "archive_session" && c.value,
      );
      expect(live?.path).toBe(config.basePath || "/");
      expect(live?.httpOnly).toBe(true);
      expect(live?.sameSite).toBe("Strict");
      if (config.basePath)
        expect(login.cookies.some((c) => c.path === "/" && !c.value)).toBe(
          true,
        );
      const sessionHeaders = {
        origin: config.origin,
        cookie: `archive_session=${live!.value}`,
        "x-csrf-token": login.json().csrf,
      };
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          ...sessionHeaders,
          origin: config.origin + config.basePath + "/invalid",
        },
      });
      expect(invalid.statusCode).toBe(403);
      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: sessionHeaders,
      });
      expect(logout.statusCode).toBe(200);
      expect(
        logout.cookies.some(
          (c) => c.path === (config.basePath || "/") && !c.value,
        ),
      ).toBe(true);
      expect(
        (await app.inject({ url: "/api/v1/auth/me", headers: sessionHeaders }))
          .statusCode,
      ).toBe(401);
    });
    it("preserves old versions and repairs only failed images", async () => {
      vi.mocked(safeFetch).mockRejectedValue(
        new AppError("IMAGE_FAILED", "fixture failed", 422),
      );
      await archiveArticle(
        account,
        {
          ...ref,
          html: ref.html + '<img src="https://mmbiz.qpic.cn/missing">',
        },
        async () => {},
      );
      const a = (await one("SELECT * FROM articles WHERE id=$1", [articleId]))!;
      expect(a.resource_state).toBe("missing");
      const v = (await one("SELECT * FROM article_versions WHERE id=$1", [
        a.current_version_id,
      ]))!;
      vi.mocked(safeFetch).mockResolvedValue({
        body: image,
        mime: "image/png",
        status: 200,
        url: "https://mmbiz.qpic.cn/missing",
      });
      const n = vi.mocked(safeFetch).mock.calls.length;
      await repairImages(a, v, async () => {});
      expect(vi.mocked(safeFetch).mock.calls.length - n).toBe(2);
      expect(
        (await one(
          "SELECT count(*)::int AS n FROM article_versions WHERE article_id=$1",
          [articleId],
        ))!.n,
      ).toBe(2);
    });
    it("does not merge same-title articles across accounts or leak assets", async () => {
      const b = await archiveArticle(
        other,
        {
          ...ref,
          biz: "BIZB",
          key: "BIZB:100:1",
          url: ref.url.replace("BIZA", "BIZB"),
        },
        async () => {},
      );
      expect(b.articleId).not.toBe(articleId);
      expect(
        (
          await app.inject({
            url: `/api/v1/articles/${b.articleId}`,
            headers: opHeaders,
          })
        ).statusCode,
      ).toBe(403);
      const asset = await one("SELECT id FROM assets WHERE account_id=$1", [
        other.id,
      ]);
      expect(
        (
          await app.inject({
            url: `/api/v1/assets/${asset!.id}`,
            headers: opHeaders,
          })
        ).statusCode,
      ).toBe(403);
    });
    it("returns stable idempotency keys and permits only one account task", async () => {
      const a = await createJob(
        "sync",
        account.id,
        adminId,
        { mode: "full" },
        "same-click",
      );
      const b = await createJob(
        "sync",
        account.id,
        adminId,
        { mode: "full" },
        "same-click",
      );
      expect(a.id).toBe(b.id);
      await expect(
        createJob("sync", account.id, adminId, {}),
      ).rejects.toMatchObject({ code: "JOB_ACTIVE" });
      await actionJob(a.id, "cancel");
    });
    it("resumes safely, reconciles lists and keeps missing coverage distinct", async () => {
      await db.query(
        "INSERT INTO connections(account_id,kind,secret) VALUES($1,'official',$2),($1,'browser',$2)",
        [account.id, seal({}, `${account.id}:official`)],
      );
      const official = vi
        .spyOn(OfficialApiAdapter.prototype, "list")
        .mockResolvedValue({
          items: [ref],
          cursor: null,
          ended: true,
          totalMessages: 1,
          messageCount: 1,
          evidence: "official_api",
        });
      const browser = vi
        .spyOn(BackendBrowserAdapter.prototype, "list")
        .mockResolvedValue({
          items: [
            {
              ...ref,
              html: undefined,
              source: "browser",
              sourceId: "backend-1",
            },
          ],
          cursor: null,
          ended: true,
          totalMessages: 1,
          messageCount: 1,
          evidence: "backend_count_reconciled",
        });
      const j = await createJob("sync", account.id, adminId, { mode: "full" });
      await actionJob(j.id, "pause");
      await runJob(j.id);
      expect(
        (await one("SELECT state FROM jobs WHERE id=$1", [j.id]))!.state,
      ).toBe("paused");
      await actionJob(j.id, "resume");
      await runJob(j.id);
      expect(
        (await one("SELECT state FROM jobs WHERE id=$1", [j.id]))!.state,
      ).toBe("succeeded");
      expect(
        (await one("SELECT coverage FROM accounts WHERE id=$1", [account.id]))!
          .coverage,
      ).toBe("verified");
      await runJob(j.id);
      expect(
        (await one(
          "SELECT count(*)::int AS n FROM articles WHERE account_id=$1",
          [account.id],
        ))!.n,
      ).toBe(1);
      official.mockRestore();
      browser.mockRestore();
    });
    it("freezes export versions, streams a readable ZIP and rechecks revoked access", async () => {
      const user = { id: operatorId, role: "operator" };
      const job = await createExport(user, [articleId], "export-snapshot");
      await db.query("UPDATE articles SET title='后来更新的标题' WHERE id=$1", [
        articleId,
      ]);
      await runJob(job.id);
      const e = (await one("SELECT * FROM exports WHERE job_id=$1", [job.id]))!;
      expect(e.state).toBe("ready");
      const dir = await mkdtemp(join(tmpdir(), "wechat-zip-"));
      try {
        const chunks = [];
        for await (const b of await store.get(e.storage_key)) chunks.push(b);
        const path = join(dir, "export.zip");
        await writeFile(path, Buffer.concat(chunks));
        execFileSync("unzip", ["-t", path]);
        const manifest = JSON.parse(
          execFileSync("unzip", ["-p", path, "manifest.json"]).toString(),
        );
        expect(manifest.articles[0].title).toBe(ref.title);
        const markdown = execFileSync("unzip", [
          "-p",
          path,
          manifest.articles[0].file,
        ]).toString();
        expect(markdown).toContain("images/");
        expect(markdown).toContain("author: null");
        expect(
          (
            await app.inject({
              url: `/api/v1/exports/${e.id}/download`,
              headers: opHeaders,
            })
          ).statusCode,
        ).toBe(200);
        await db.query("DELETE FROM account_access WHERE user_id=$1", [
          operatorId,
        ]);
        expect(
          (
            await app.inject({
              url: `/api/v1/exports/${e.id}/download`,
              headers: opHeaders,
            })
          ).statusCode,
        ).toBe(403);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("supports Chinese substring search and publishes OpenAPI", async () => {
      const res = await app.inject({
        url: "/api/v1/articles?q=" + encodeURIComponent("归档测试"),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBeGreaterThan(0);
      const spec = await app.inject({ url: "/api/v1/openapi.json", headers });
      expect(spec.statusCode).toBe(200);
      expect(spec.json().servers).toEqual([
        { url: config.origin + config.basePath },
      ]);
      expect(spec.json().paths["/api/v1/accounts"]).toBeTruthy();
      expect(
        spec.json().paths["/api/v1/exports"].post.responses["202"],
      ).toBeTruthy();
      expect(
        spec.json().paths["/api/v1/imports"].post.requestBody.content[
          "application/json"
        ].schema.properties.urls.maxItems,
      ).toBe(1000);
    });
    it("surfaces a channel failure while retaining official progress", async () => {
      const official = vi
        .spyOn(OfficialApiAdapter.prototype, "list")
        .mockResolvedValue({
          items: [ref],
          cursor: null,
          ended: true,
          totalMessages: 1,
          messageCount: 1,
          evidence: "official_api",
        });
      const browser = vi
        .spyOn(BackendBrowserAdapter.prototype, "list")
        .mockRejectedValue(new AppError("AUTH_EXPIRED", "重新扫码", 409));
      const j = await createJob("sync", account.id, adminId, {
        mode: "incremental",
      });
      await runJob(j.id);
      const done = (await one("SELECT * FROM jobs WHERE id=$1", [j.id]))!;
      expect(done.state).toBe("partial");
      expect(done.processed).toBe(1);
      expect(done.report.complete).toBe(false);
      expect(done.report.channels.browser.ok).toBe(false);
      official.mockRestore();
      browser.mockRestore();
    });
    it("cools down once and then waits for a human, honoring Retry-After", async () => {
      const official = vi
        .spyOn(OfficialApiAdapter.prototype, "list")
        .mockRejectedValue(
          new AppError("RATE_LIMIT", "限流", 429, false, 3600000),
        );
      const j = await createJob("sync", account.id, adminId, { mode: "full" });
      await runJob(j.id);
      const cool = (await one("SELECT * FROM jobs WHERE id=$1", [j.id]))!;
      expect(cool.state).toBe("cooldown");
      expect(new Date(cool.next_run_at).getTime() - Date.now()).toBeGreaterThan(
        3500000,
      );
      await db.query("UPDATE jobs SET state='queued' WHERE id=$1", [j.id]);
      await runJob(j.id);
      expect(
        (await one("SELECT state FROM jobs WHERE id=$1", [j.id]))!.state,
      ).toBe("waiting_auth");
      await actionJob(j.id, "cancel");
      official.mockRestore();
    });
    it("searches and manages tasks at the 10-account / 1,000-article capacity target", async () => {
      const accounts = (
        await db.query(
          "INSERT INTO accounts(name,original_id,auto_sync) SELECT '容量验收账号 '||g,'gh_capacity'||g,false FROM generate_series(1,8) g RETURNING id",
        )
      ).rows;
      const ids = [account.id, other.id, ...accounts.map((a) => a.id)];
      for (let i = 0; i < ids.length; i++)
        await db.query(
          "INSERT INTO articles(account_id,platform_key,title,source_url) SELECT $1,'capacity:'||g,'容量验收 中文搜索 '||g,'https://mp.weixin.qq.com/s/capacity'||g FROM generate_series(1,100) g ON CONFLICT DO NOTHING",
          [ids[i]],
        );
      const start = performance.now();
      const result = await app.inject({
        url: "/api/v1/articles?q=" + encodeURIComponent("容量验收"),
        headers,
      });
      expect(result.json().total).toBe(1000);
      expect(result.json().items.length).toBe(30);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(
        (await app.inject({ url: "/api/v1/jobs", headers })).statusCode,
      ).toBe(200);
    });
    it("archives official content independently and leaves unknown publication dates empty", async () => {
      vi.mocked(safeFetch)
        .mockClear()
        .mockRejectedValue(
          new AppError("VERIFICATION_REQUIRED", "页面需要验证", 409),
        );
      const saved = await archiveArticle(
        account,
        {
          ...ref,
          key: "BIZA:900:1",
          sourceId: "official-undated",
          url: "https://mp.weixin.qq.com/s?__biz=BIZA&mid=900&idx=1",
          publishedAt: null,
          html: "<p>官方接口返回的正文，无需后台会话。</p>",
        },
        async () => {},
      );
      const article = (await one("SELECT * FROM articles WHERE id=$1", [
        saved.articleId,
      ]))!;
      expect(article.published_at).toBeNull();
      expect(saved.missing).toBe(false);
      expect(safeFetch).not.toHaveBeenCalled();
      const enriched = await archiveArticle(
        { ...account, skipPageEnrichment: false },
        {
          ...ref,
          key: "short:official-undated",
          sourceId: "official-short",
          url: "https://mp.weixin.qq.com/s/official-undated",
          biz: undefined,
          publishedAt: null,
          html: "<p>页面验证不应阻止已有的官方正文归档。</p>",
        },
        async () => {},
      );
      expect(enriched.missing).toBe(false);
      expect(safeFetch).toHaveBeenCalledTimes(1);
    });
  },
);
