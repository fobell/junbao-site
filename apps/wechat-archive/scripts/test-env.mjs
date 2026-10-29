import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const body = `NODE_ENV=test\nDATABASE_URL=postgres://archive:archive@127.0.0.1:25432/archive\nREDIS_URL=redis://127.0.0.1:26379\nAPP_ORIGIN=http://localhost:5173\nAPP_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nBROWSER_SERVICE_TOKEN=${randomBytes(32).toString("hex")}\nBOOTSTRAP_TOKEN=${randomBytes(32).toString("hex")}\nDATA_DIR=./data/test\nREQUEST_DELAY_MS=0\n`;
try {
  await writeFile(".env.test", body, { flag: "wx", mode: 0o600 });
  console.log("Isolated .env.test created.");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  console.log("Existing .env.test preserved.");
}
