import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateDeployment } from "../scripts/deployment-check.mjs";

const valid = {
  DOMAIN: "archive.company.cn",
  APP_ORIGIN: "https://archive.company.cn",
  STORAGE_DRIVER: "local",
  REQUEST_DELAY_MS: "3000",
};
test("accepts production HTTPS and local storage without inventing an egress IP", () => {
  assert.deepEqual(validateDeployment(valid), {
    domain: valid.DOMAIN,
    origin: valid.APP_ORIGIN,
    basePath: "",
    applicationUrl: valid.APP_ORIGIN,
    storage: "local",
    egressIp: "",
  });
});
test("rejects copied sample / local domains and mismatched HTTPS origins", () => {
  for (const domain of [
    "archive.example.com",
    "localhost",
    "archive.localhost",
    "https://archive.company.cn",
    "127.0.0.1",
  ])
    assert.throws(() => validateDeployment({ ...valid, DOMAIN: domain }));
  for (const origin of [
    "http://archive.company.cn",
    "https://other.company.cn",
    "https://archive.company.cn/",
  ])
    assert.throws(() => validateDeployment({ ...valid, APP_ORIGIN: origin }));
});
test("derives public application URL separately from the CSRF origin", () => {
  const result = validateDeployment({
    ...valid,
    APP_BASE_PATH: "/wechat-article-archive/",
  });
  assert.equal(result.origin, valid.APP_ORIGIN);
  assert.equal(result.basePath, "/wechat-article-archive");
  assert.equal(
    result.applicationUrl,
    valid.APP_ORIGIN + "/wechat-article-archive/",
  );
  for (const path of ["relative", "//host", "/../api", "/a?x=1", "/%2F"])
    assert.throws(() => validateDeployment({ ...valid, APP_BASE_PATH: path }));
});
test("rejects test scheduling, unsafe example egress and unexpected Compose targets", () => {
  for (const change of [
    { REQUEST_DELAY_MS: "0" },
    { SYNC_HOUR: "24" },
    { SYNC_MINUTE: "60" },
    { NODE_ENV: "test" },
    { WECHAT_EGRESS_IP: "203.0.113.10" },
    { WECHAT_EGRESS_IP: "172.16.0.5" },
    { WECHAT_EGRESS_IP: "fc00::1" },
    { COMPOSE_FILE: "compose.preview.yaml" },
  ])
    assert.throws(() => validateDeployment({ ...valid, ...change }));
});
test("requires complete HTTPS S3 configuration", () => {
  assert.throws(() => validateDeployment({ ...valid, STORAGE_DRIVER: "s3" }));
  const env = {
    ...valid,
    STORAGE_DRIVER: "s3",
    S3_ENDPOINT: "https://exampleaccount.r2.cloudflarestorage.com",
    S3_BUCKET: "archive",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "example-only",
    S3_SECRET_ACCESS_KEY: "example-only",
  };
  assert.equal(validateDeployment(env).storage, "s3");
  assert.throws(() =>
    validateDeployment({ ...env, S3_ENDPOINT: "http://storage.local" }),
  );
});
test("preserves existing credentials and produces a private, non-overwriting credential sheet", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wechat-handoff-"));
  const run = (name, args = []) =>
    execFileSync(process.execPath, [resolve(`scripts/${name}`), ...args], {
      cwd: folder,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    await writeFile(join(folder, ".env"), `APP_ORIGIN=${valid.APP_ORIGIN}\n`);
    run("init-secrets.mjs");
    const key = await readFile(join(folder, "secrets/encryption_key"), "utf8");
    run("init-secrets.mjs");
    assert.equal(
      await readFile(join(folder, "secrets/encryption_key"), "utf8"),
      key,
    );
    assert.equal((await stat(join(folder, "secrets"))).mode & 0o777, 0o700);
    assert.ok(!run("credential-sheet.mjs").includes(key));
    const output = run("credential-sheet.mjs", ["--include-secrets"]);
    assert.ok(!output.includes(key));
    const reportPath = join(folder, "secrets/credential-sheet.local.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.secrets.encryption_key, key);
    assert.equal(report.applicationUrl, valid.APP_ORIGIN);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    assert.throws(() => run("credential-sheet.mjs", ["--include-secrets"]));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
