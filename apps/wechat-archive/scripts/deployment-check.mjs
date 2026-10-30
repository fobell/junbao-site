import { normalizeBasePath, applicationUrl } from "../src/shared/base-path.mjs";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateDeployment(env) {
  const domain = env.DOMAIN ?? "";
  const basePath = normalizeBasePath(env.APP_BASE_PATH ?? "");
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(
      domain,
    ) ||
    domain.length > 253 ||
    /(^|\.)(example\.(com|net|org)|localhost|test|invalid)$/.test(domain)
  )
    throw new Error(
      "DOMAIN 必须改为你自己的小写域名，例如 archive.你的域名；不能保留示例值。",
    );
  if (env.APP_ORIGIN !== `https://${domain}`)
    throw new Error(
      "APP_ORIGIN 必须与 DOMAIN 一致，格式为 https://域名，不带末尾斜线。",
    );
  if (env.NODE_ENV && env.NODE_ENV !== "production")
    throw new Error("生产部署不能使用测试或预览的 NODE_ENV。");
  if (env.COMPOSE_FILE || env.COMPOSE_PROJECT_NAME)
    throw new Error(
      "辅助部署脚本使用默认 compose.yaml 和项目名；自定义组合请按手册执行手工部署。",
    );
  if (!["local", "s3"].includes(env.STORAGE_DRIVER ?? "local"))
    throw new Error("STORAGE_DRIVER 只能为 local 或 s3。");
  if (!["standalone", "tools"].includes(env.DEPLOYMENT_MODE ?? "standalone"))
    throw new Error("DEPLOYMENT_MODE must be standalone or tools.");
  for (const name of [
    "WORKER_CONCURRENCY",
    "BROWSER_MAX_SESSIONS",
    "BROWSER_MAX_CONTEXTS",
  ]) {
    if (
      env[name] !== undefined &&
      (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) < 1)
    )
      throw new Error(`${name} must be a positive integer`);
  }
  const delay = Number(env.REQUEST_DELAY_MS ?? "3000");
  if (!Number.isFinite(delay) || delay < 3000)
    throw new Error(
      "生产 REQUEST_DELAY_MS 至少为 3000，不能使用测试环境的零间隔。",
    );
  for (const [name, max, fallback] of [
    ["SYNC_HOUR", 23, "3"],
    ["SYNC_MINUTE", 59, "30"],
  ]) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0 || value > max)
      throw new Error(`${name} 超出允许范围。`);
  }
  const egressIp = env.WECHAT_EGRESS_IP ?? "";
  const [a, b] = egressIp.split(".").map(Number);
  if (
    egressIp &&
    (!isIP(egressIp) ||
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(
        egressIp,
      ) ||
      (isIP(egressIp) === 4 &&
        (a >= 224 ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 198 && (b === 18 || b === 19)))) ||
      (isIP(egressIp) === 6 &&
        (!/^[23]/i.test(egressIp) || /^2001:db8:/i.test(egressIp))))
  )
    throw new Error(
      "WECHAT_EGRESS_IP 请填写实际公网出口 IP，不能使用示例、回环或私网地址。",
    );
  if (env.STORAGE_DRIVER === "s3") {
    let endpoint;
    try {
      endpoint = new URL(env.S3_ENDPOINT);
    } catch {
      throw new Error("S3_ENDPOINT 无效。");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      !env.S3_BUCKET ||
      !env.S3_REGION
    )
      throw new Error("S3 模式需要 HTTPS 端点、桶名和区域。");
    if (
      (!env.S3_ACCESS_KEY_ID && !env.S3_ACCESS_KEY_ID_FILE) ||
      (!env.S3_SECRET_ACCESS_KEY && !env.S3_SECRET_ACCESS_KEY_FILE)
    )
      throw new Error("S3 模式缺少访问凭据或其 Secret 文件配置。");
  }
  return {
    domain,
    origin: env.APP_ORIGIN,
    basePath,
    applicationUrl: applicationUrl(env.APP_ORIGIN, basePath),
    storage: env.STORAGE_DRIVER ?? "local",
    egressIp,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const config = validateDeployment(parseEnv(readFileSync(".env", "utf8")));
    if (!config.egressIp)
      console.error(
        "提示：尚未填写服务器出口 IP；接入官方渠道前需核实并追加微信白名单。",
      );
    console.log(
      process.argv.includes("--origin")
        ? config.origin
        : process.argv.includes("--url")
          ? config.applicationUrl
          : JSON.stringify(config, null, 2),
    );
  } catch (e) {
    console.error(
      e.code === "ENOENT"
        ? "缺少 .env，请先复制配置模板并填写域名。"
        : e.message,
    );
    process.exitCode = 1;
  }
}
