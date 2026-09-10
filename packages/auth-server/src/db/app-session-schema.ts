import { index, text, timestamp } from "drizzle-orm/pg-core";
import { authSchema } from "./auth-schema.js";

// Opaque cookie IDs are hashed; token-bearing session data is AES-GCM encrypted.
export const appBSession = authSchema.table("app_b_session", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("app_b_session_expiry_idx").on(table.expiresAt)]);
