import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const url = new URL(process.env.DATABASE_URL);
if (process.env.DEPLOYMENT_ENVIRONMENT !== 'production' || url.pathname !== '/production-auth') throw new Error('Production Auth database required');
const pool = new pg.Pool({connectionString: url.toString(), max: 1, connectionTimeoutMillis: 15000});
try {
  const result = await pool.query('SELECT current_database() AS name, current_user AS role');
  if (result.rows[0]?.name !== 'production-auth') throw new Error('Unexpected connected database');
  console.info(`Connected to production-auth as ${result.rows[0].role}`);
  await migrate(drizzle(pool), {migrationsFolder: 'packages/auth-server/drizzle'});
  console.info('Production Auth migrations applied');
} catch (error) {
  const cause = error.cause ?? error;
  // Avoid dumping connection objects or parameters into CI logs.
  console.error('Migration failed:', cause.code ?? '', String(cause.message).replace(/pscale_pw_[A-Za-z0-9_-]+/g, '[REDACTED]'));
  process.exitCode = 1;
} finally {await pool.end();}
