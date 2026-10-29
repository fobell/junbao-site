import { migrate } from "drizzle-orm/node-postgres/migrator";
import { orm, pool } from "../src/server/db.js";
await migrate(orm, { migrationsFolder: "./migrations" });
await pool.end();
console.log("Database migrations complete.");
