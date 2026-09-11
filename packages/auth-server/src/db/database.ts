import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
export function createDatabase(connectionString: string) {
  // Request-scoped on Workers. Hyperdrive owns pooling across requests.
  const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
export type Database = ReturnType<typeof createDatabase>["db"];
