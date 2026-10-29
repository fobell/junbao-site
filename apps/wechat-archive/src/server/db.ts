import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config.js";
export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(
    text: string,
    args?: any[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 12,
});
export const orm = drizzle(pool);
export const db: Sql = pool;
export async function one<T extends Row = Row>(
  sql: string,
  args: any[] = [],
  conn: Sql = db,
): Promise<T | undefined> {
  return (await conn.query<T>(sql, args)).rows[0];
}
export async function transaction<T>(
  fn: (conn: Sql) => Promise<T>,
): Promise<T> {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }
}
export async function audit(
  userId: string | null,
  action: string,
  targetId: string | null,
  details: Row = {},
) {
  await db.query(
    "INSERT INTO audit_events(user_id,action,target_id,details) VALUES($1,$2,$3,$4)",
    [userId, action, targetId, JSON.stringify(details)],
  );
}
