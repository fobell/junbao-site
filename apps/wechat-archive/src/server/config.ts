import { normalizeBasePath } from "../shared/base-path.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch {
  /* Docker injects environment directly. */
}
function value(name: string, fallback = ""): string {
  const file = process.env[`${name}_FILE`];
  return file
    ? readFileSync(file, "utf8").trim()
    : (process.env[name] ?? fallback);
}
export function positiveInteger(name: string, fallback: number) {
  const raw = value(name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}
export const config = {
  production: process.env.NODE_ENV === "production",
  basePath: normalizeBasePath(value("APP_BASE_PATH")),
  port: Number(value("PORT", "3000")),
  origin: value("APP_ORIGIN", "http://localhost:5173").replace(/\/$/, ""),
  databaseUrl: value(
    "DATABASE_URL",
    "postgres://archive:archive@127.0.0.1:5432/archive",
  ),
  redisUrl: value("REDIS_URL", "redis://127.0.0.1:6379"),
  encryptionKey: value("APP_ENCRYPTION_KEY"),
  browserToken: value("BROWSER_SERVICE_TOKEN"),
  bootstrapToken: value("BOOTSTRAP_TOKEN"),
  browserUrl: value("BROWSER_SERVICE_URL", "http://127.0.0.1:3001"),
  browserProxy: value("BROWSER_PROXY", "http://127.0.0.1:3128"),
  egressIp: value("WECHAT_EGRESS_IP"),
  storageDriver: value("STORAGE_DRIVER", "local"),
  dataDir: resolve(value("DATA_DIR", "./data")),
  s3Endpoint: value("S3_ENDPOINT"),
  s3Region: value("S3_REGION", "auto"),
  s3Bucket: value("S3_BUCKET"),
  s3AccessKey: value("S3_ACCESS_KEY_ID"),
  s3Secret: value("S3_SECRET_ACCESS_KEY"),
  s3PathStyle: value("S3_FORCE_PATH_STYLE", "false") === "true",
  syncHour: Number(value("SYNC_HOUR", "3")),
  syncMinute: Number(value("SYNC_MINUTE", "30")),
  requestDelay: Number(value("REQUEST_DELAY_MS", "3000")),
  workerConcurrency: positiveInteger("WORKER_CONCURRENCY", 2),
  browserMaxSessions: positiveInteger("BROWSER_MAX_SESSIONS", 3),
  browserMaxContexts: positiveInteger("BROWSER_MAX_CONTEXTS", 4),
  maxImageBytes: 25 * 1024 * 1024,
  maxHtmlBytes: 8 * 1024 * 1024,
  maxExportBytes: 2 * 1024 ** 3,
};
export function validateConfig() {
  if (
    process.env.BUILT_APP_BASE_PATH !== undefined &&
    config.basePath !== normalizeBasePath(process.env.BUILT_APP_BASE_PATH)
  )
    throw new Error(
      "APP_BASE_PATH differs from the web build; rebuild the application image",
    );
  if (!/^[a-f\d]{64}$/i.test(config.encryptionKey))
    throw new Error("APP_ENCRYPTION_KEY must be a 32-byte hex secret");
  if (config.browserToken.length < 32)
    throw new Error(
      "BROWSER_SERVICE_TOKEN must contain at least 32 characters",
    );
  if (config.production && !config.origin.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must use HTTPS");
  if (!["local", "s3"].includes(config.storageDriver))
    throw new Error("Invalid STORAGE_DRIVER");
  if (
    config.storageDriver === "s3" &&
    (!config.s3Endpoint ||
      !config.s3Bucket ||
      !config.s3AccessKey ||
      !config.s3Secret)
  )
    throw new Error("S3 configuration is incomplete");
}
