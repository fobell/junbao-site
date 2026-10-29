import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import {
  readFile,
  mkdir,
  writeFile,
  readdir,
  stat,
  unlink,
  appendFile,
  rm,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import archiver from "archiver";
import { store, LocalStore } from "../src/server/storage.js";
import { db, pool } from "../src/server/db.js";
const action = process.argv[2],
  folder = process.argv[3] ?? "/snapshot";
if (action === "snapshot") {
  const local = new LocalStore(join(folder, "objects"));
  const sums: Record<string, string> = {};
  for await (const key of store.keys()) {
    if (!key.startsWith("raw/") && !key.startsWith("assets/")) continue;
    await local.put(key, await store.get(key));
    const digest = createHash("sha256");
    for await (const b of await local.get(key)) digest.update(b);
    sums[key] = digest.digest("hex");
  }
  const databaseHash = createHash("sha256");
  for await (const b of createReadStream(join(folder, "database.dump")))
    databaseHash.update(b);
  sums["database.dump"] = databaseHash.digest("hex");
  await writeFile(
    join(folder, "checksums.json"),
    JSON.stringify(sums, null, 2),
  );
  console.log(
    `Snapshot: ${Object.keys(sums).length} verified files. Export ZIPs are intentionally regenerated after recovery.`,
  );
} else if (action === "seal") {
  const key = Buffer.from(
    (await readFile(process.env.BACKUP_KEY_FILE!, "utf8")).trim(),
    "hex",
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const archive = archiver("zip", { zlib: { level: 1 } }),
    pass = new PassThrough();
  archive.pipe(pass);
  archive.on("error", (e) => pass.destroy(e));
  const output = process.argv[4];
  if (!output) throw new Error("Output path required");
  await writeFile(output, Buffer.concat([Buffer.from("WCA1"), iv]), {
    mode: 0o600,
  });
  const writing = pipeline(
    pass,
    cipher,
    createWriteStream(output, { flags: "a", mode: 0o600 }),
  );
  archive.directory(folder, false);
  await archive.finalize();
  await writing;
  await appendFile(output, cipher.getAuthTag());
} else if (action === "unseal") {
  const key = Buffer.from(
    (await readFile(process.env.BACKUP_KEY_FILE!, "utf8")).trim(),
    "hex",
  );
  const file = process.argv[3],
    target = process.argv[4] ?? "/snapshot";
  const { size } = await stat(file);
  const header = Buffer.alloc(16),
    tag = Buffer.alloc(16);
  const fs = await import("node:fs/promises");
  const fh = await fs.open(file, "r");
  await fh.read(header, 0, 16, 0);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  if (header.subarray(0, 4).toString() !== "WCA1")
    throw new Error("Invalid backup");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(4));
  decipher.setAuthTag(tag);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const zip = join(target, "restore.zip");
  try {
    await pipeline(
      createReadStream(file, { start: 16, end: size - 17 }),
      decipher,
      createWriteStream(zip, { mode: 0o600 }),
    );
    execFileSync("unzip", ["-q", zip, "-d", target]);
  } finally {
    await unlink(zip).catch(() => {});
  }
  console.log("Authenticated backup extracted.");
} else if (action === "restore-files") {
  const local = new LocalStore(join(folder, "objects"));
  const sums = JSON.parse(
    await readFile(join(folder, "checksums.json"), "utf8"),
  );
  for (const [key, expected] of Object.entries(sums)) {
    const h = createHash("sha256");
    const input =
      key === "database.dump"
        ? createReadStream(join(folder, key))
        : await local.get(key);
    for await (const b of input) h.update(b);
    if (h.digest("hex") !== expected)
      throw new Error(`Checksum mismatch ${key}`);
  }
  for await (const key of local.keys())
    await store.put(key, await local.get(key), "application/octet-stream");
  for (const row of (
    await db.query(
      "SELECT raw_key AS key FROM article_versions UNION SELECT storage_key AS key FROM assets",
    )
  ).rows)
    await store.size(row.key);
  await db.query(
    "DELETE FROM sessions; DELETE FROM browser_sessions; UPDATE exports SET state='expired',storage_key=NULL; UPDATE jobs SET state='queued',lease_id=NULL WHERE state='running'; UPDATE connections SET token_secret=NULL,token_expires_at=NULL;",
  );
  console.log(
    "Objects verified and restored. Pending jobs will be recovered by the outbox dispatcher.",
  );
} else if (action === "backup-status") {
  await db.query(
    "INSERT INTO system_status(key,value) VALUES('backup',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [
      JSON.stringify({
        ok: process.argv[3] === "ok",
        message: process.argv[4] ?? "",
      }),
    ],
  );
} else if (action === "rotate") {
  const files = (await readdir(folder))
    .filter((n) => /^wechat-(daily|weekly)-[0-9T-]+\.wca$/.test(n))
    .sort()
    .reverse();
  for (const type of ["daily", "weekly"])
    for (const file of files
      .filter((n) => n.startsWith(`wechat-${type}`))
      .slice(type === "daily" ? 7 : 4))
      await rm(join(folder, file));
} else if (action === "reset-totp") {
  if (!process.argv[3]) throw new Error("Username required");
  await db.query(
    "UPDATE users SET totp_enabled=false,totp_secret=NULL,last_totp_step=-1,recovery_hashes='[]' WHERE username=$1",
    [process.argv[3]],
  );
  await db.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=$1)",
    [process.argv[3]],
  );
  console.log(
    "TOTP reset. The administrator must enroll again after password login.",
  );
} else
  throw new Error(
    "Use snapshot | seal | unseal | restore-files | backup-status | rotate | reset-totp",
  );
await pool.end();
