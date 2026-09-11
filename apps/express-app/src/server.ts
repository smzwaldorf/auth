import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
const config = parseConfig(process.env, process.env.NODE_ENV === "production");
const server = serve({ fetch: createApp(config).fetch, hostname: "127.0.0.1", port: Number(new URL(config.APP_B_ORIGIN).port || 4000) });
async function shutdown() { server.close(); }
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
