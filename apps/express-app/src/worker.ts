import pg from "pg";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
interface Env { HYPERDRIVE: { connectionString: string }; AUTH_ISSUER: string; APP_A_ORIGIN: string; APP_B_ORIGIN: string; APP_B_CLIENT_SECRET: string; APP_B_COOKIE_SECRET: string }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = parseConfig({ ...env }, true);
    const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 2, connectionTimeoutMillis: 10_000 });
    try { return await createApp(config, pool).fetch(request); }
    finally { await pool.end(); }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    try { await client.connect(); await client.query("DELETE FROM app_b.session WHERE expires_at <= now()"); }
    finally { await client.end(); }
  },
};
