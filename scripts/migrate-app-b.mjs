import fs from "node:fs/promises";
import pg from "pg";
const connectionString = process.env.APP_B_DATABASE_URL ?? process.env.PLANETSCALE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set APP_B_DATABASE_URL or DATABASE_URL");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(await fs.readFile(new URL("../apps/express-app/migrations/0001_sessions.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
  console.log("App B session schema migrated in the app_b schema.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {}); throw error;
} finally { await client.end(); }
