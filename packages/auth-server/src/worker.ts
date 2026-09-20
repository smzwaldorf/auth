import { createApp } from "./app.js";
import { createDatabase } from "./db/database.js";
import { requestDatabase, withRequestDatabase } from "./db/request-scope.js";
import { parseRuntimeConfig } from "./runtime-config.js";
export interface Env {
  MAGIC_LINK_ENABLED?: string;
  MAGIC_LINK_FROM?: string;
  RESEND_API_KEY?: string;
  STAGING_ADMIN_EMAIL?: string;
  STAGING_PARENT_EMAIL?: string;
  STAGING_PARENT_EMAILS?: string;
  HYPERDRIVE: { connectionString: string };
  AUTH_ISSUER: string;
  APP_A_ORIGIN: string;
  APP_B_ORIGIN: string;
  CMS_ORIGIN?: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_B_CLIENT_SECRET: string;
}

let runtime: ReturnType<typeof createApp> | undefined;

function appFor(env: Env) {
  if (!runtime) {
    const config = parseRuntimeConfig({ ...env, NODE_ENV: "production" });
    runtime = createApp(config, requestDatabase);
  }
  return runtime;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const database = createDatabase(env.HYPERDRIVE.connectionString);
    try {
      return await withRequestDatabase(database.db, () => appFor(env).fetch(request));
    } finally {
      await database.close();
    }
  },
};
