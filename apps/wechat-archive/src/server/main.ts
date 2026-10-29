import { config, validateConfig } from "./config.js";
import { buildApp } from "./api.js";
import { pool } from "./db.js";
validateConfig();
const app = await buildApp();
await app.listen({ host: "0.0.0.0", port: config.port });
process.on("SIGTERM", async () => {
  await app.close();
  await pool.end();
});
