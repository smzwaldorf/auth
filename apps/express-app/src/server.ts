import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
const config = parseConfig(process.env, process.env.NODE_ENV === "production");
if (config.production && !process.env.APP_B_DATABASE_URL) throw new Error("Production App B requires its own APP_B_DATABASE_URL");
const pool = new pg.Pool({ connectionString: process.env.APP_B_DATABASE_URL ?? "postgres://smz:smz@localhost:5432/smz_app_b" });
const server = serve({ fetch: createApp(config, pool).fetch, hostname: "127.0.0.1", port: Number(new URL(config.APP_B_ORIGIN).port || 4000) });
async function shutdown() { server.close(); await pool.end(); }
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
