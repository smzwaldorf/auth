import pg from "pg";

const expectedConfirmation = "reset-smz-auth-staging-2026-09-20";
const expectedDatabase = "smz-auth";
const expectedHost = "aws-ap-northeast-1-2.pg.psdb.cloud";

if (process.env.RESET_STAGING_AUTH_CONFIRM !== expectedConfirmation) {
  throw new Error(`Set RESET_STAGING_AUTH_CONFIRM=${expectedConfirmation} to run the one-time reset`);
}
if (process.env.NODE_ENV !== "production") {
  throw new Error("The hosted staging reset requires NODE_ENV=production");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const target = new URL(process.env.DATABASE_URL);
const database = decodeURIComponent(target.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(target.protocol)) throw new Error("Expected a PostgreSQL DATABASE_URL");
if (target.hostname !== expectedHost || database !== expectedDatabase) {
  throw new Error(`Refusing to reset unexpected database target ${target.hostname}/${database}`);
}

const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  const result = await client.query("select current_database() as database, current_user as role");
  if (result.rows[0]?.database !== expectedDatabase) throw new Error("Connected database does not match the guarded target");

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(1397578324)");
    await client.query('drop schema if exists "directory" cascade');
    await client.query('drop schema if exists "auth" cascade');
    await client.query('drop schema if exists "drizzle" cascade');
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  console.log(JSON.stringify({ reset: true, database: expectedDatabase, schemas: ["auth", "directory", "drizzle"] }));
} finally {
  await client.end();
}
