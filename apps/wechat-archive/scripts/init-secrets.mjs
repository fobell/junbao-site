import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
await mkdir("secrets", { recursive: true, mode: 0o700 });
await chmod("secrets", 0o700);
for (const name of [
  "database_password",
  "encryption_key",
  "browser_token",
  "bootstrap_token",
  "backup_key",
]) {
  try {
    await writeFile(`secrets/${name}`, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o444,
    });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
const password = (await readFile("secrets/database_password", "utf8")).trim();
try {
  await writeFile(
    "secrets/database_url",
    `postgres://archive:${encodeURIComponent(password)}@db:5432/archive`,
    { flag: "wx", mode: 0o444 },
  );
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
console.log(
  "Secrets initialized without overwriting existing keys. Read secrets/bootstrap_token on your server for first-time setup. Back up encryption_key and backup_key separately.",
);
