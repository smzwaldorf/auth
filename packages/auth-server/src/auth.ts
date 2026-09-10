import { config } from "./config.js";
import { db } from "./db/client.js";
import { createAuth } from "./auth-factory.js";
export const auth = createAuth(config, db);
export const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
