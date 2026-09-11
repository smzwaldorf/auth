import fs from "node:fs/promises";
import pg from "pg";
const connectionString = process.env.APP_B_DATABASE_URL;
if (!connectionString) throw new Error("Set APP_B_DATABASE_URL to App B's own database");
if (connectionString === process.env.DATABASE_URL || connectionString === process.env.PLANETSCALE_DATABASE_URL) throw new Error("App B must not use Auth's database");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(await fs.readFile(new URL("../apps/express-app/migrations/0001_sessions.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
  console.log("App B session schema migrated in its separate database.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {}); throw error;
} finally { await client.end(); }
