import { serve } from "@hono/node-server";
import { config, authPort, authOrigin } from "./config.js";
import { db, closeDatabase } from "./db/client.js";
import { createApp } from "./app.js";
const app = createApp(config, db);
const server = serve({ fetch: (request, env) => app.fetch(request, { transport: { remoteAddress: env.incoming.socket.remoteAddress } }), hostname: "127.0.0.1", port: authPort }, () => console.log(`SMZ Identity listening on ${authOrigin}`));
async function shutdown() { server.close(); await closeDatabase(); }
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
