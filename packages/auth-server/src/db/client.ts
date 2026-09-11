import { config } from "../config.js";
import { createDatabase } from "./database.js";
export const { db, pool, close: closeDatabase } = createDatabase(config.DATABASE_URL);
