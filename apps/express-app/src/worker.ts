import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
interface Env { AUTH_ISSUER: string; APP_A_ORIGIN: string; APP_B_ORIGIN: string; APP_B_CLIENT_SECRET: string; APP_B_COOKIE_SECRET: string }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createApp(parseConfig({ ...env }, true)).fetch(request);
  },
};
