import { mkdir, writeFile } from "node:fs/promises";
import { buildApp } from "../src/server/api.js";
import { pool } from "../src/server/db.js";
import { openApiDocument } from "../src/server/openapi.js";
const app = await buildApp();
await app.ready();
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/openapi.json",
  JSON.stringify(openApiDocument(app.swagger()), null, 2),
);
await app.close();
await pool.end();
console.log("Generated docs/openapi.json from registered API routes.");
