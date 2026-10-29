import { createHash } from "node:crypto";
import { LocalStore, S3Store, type BlobStore } from "../src/server/storage.js";
import { pool } from "../src/server/db.js";
const direction = process.argv[2];
if (!["to-s3", "to-local"].includes(direction))
  throw new Error(
    "Use storage:migrate -- to-s3 | to-local. Stop API and worker first.",
  );
const local = new LocalStore(),
  remote = new S3Store();
const [source, target]: BlobStore[] =
  direction === "to-s3" ? [local, remote] : [remote, local];
async function digest(store: BlobStore, key: string) {
  const h = createHash("sha256");
  for await (const b of await store.get(key)) h.update(b);
  return h.digest("hex");
}
let count = 0;
for await (const key of source.keys()) {
  await target.put(key, await source.get(key), "application/octet-stream");
  if ((await digest(source, key)) !== (await digest(target, key)))
    throw new Error(`Checksum mismatch: ${key}`);
  count++;
}
console.log(
  `${count} objects copied and verified. Object keys are unchanged; switch STORAGE_DRIVER and restart only after success. Originals were retained.`,
);
await pool.end();
