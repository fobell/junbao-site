import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateDeployment } from "../scripts/deployment-check.mjs";

const choose = (extra = {}) => execFileSync("bash", ["-c", 'source scripts/compose.sh; docker() { printf "%s\\n" "$@"; }; dc config --quiet'], {
  env: { ...process.env, DEPLOYMENT_MODE: "standalone", COMPOSE_FILE: "", COMPOSE_PROJECT_NAME: "", COMPOSE_PROFILES: "", ...extra }, encoding: "utf8",
});
test("all lifecycle commands share the selected Compose file", () => {
  assert.match(choose(), /compose.yaml/);
  assert.match(choose({ DEPLOYMENT_MODE: "tools" }), /compose.tools.yaml/);
  for (const script of ["deploy.sh", "check-deployment.sh", "backup.sh", "restore.sh"]) {
    const source = readFileSync(`scripts/${script}`, "utf8");
    assert.match(source, /source scripts\/compose.sh/);
    assert.doesNotMatch(source, /docker compose/);
  }
});
test("unknown modes and target overrides fail closed", () => {
  for (const extra of [{ DEPLOYMENT_MODE: "bad" }, { COMPOSE_PROJECT_NAME: "other" }, { COMPOSE_FILE: "bad.yaml" }, { COMPOSE_PROFILES: "*" }]) {
    assert.throws(() => execFileSync("bash", ["-ec", "source scripts/compose.sh"], { env: { ...process.env, ...extra }, stdio: "pipe" }));
  }
});
test("production mode and concurrency validation reject unsafe values", () => {
  const base = { DOMAIN: "tools.junbao.ai", APP_ORIGIN: "https://tools.junbao.ai", DEPLOYMENT_MODE: "tools", WORKER_CONCURRENCY: "1", BROWSER_MAX_SESSIONS: "1", BROWSER_MAX_CONTEXTS: "2" };
  assert.equal(validateDeployment(base).domain, "tools.junbao.ai");
  for (const name of ["WORKER_CONCURRENCY", "BROWSER_MAX_SESSIONS", "BROWSER_MAX_CONTEXTS"])
    for (const value of ["0", "-1", "1.5", "NaN", ""]) assert.throws(() => validateDeployment({ ...base, [name]: value }));
});
