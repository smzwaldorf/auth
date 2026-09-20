import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
export function createDatabase(connectionString: string) {
  // The Worker keeps this pool for the isolate lifetime; Hyperdrive owns the
  // database-side pooling and pg reconnects after idle connections expire.
  const pool = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
export type Database = ReturnType<typeof createDatabase>["db"];
