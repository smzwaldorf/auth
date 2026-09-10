import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) throw new Error("Production migrations require an explicit direct DATABASE_URL");

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/auth-schema.ts", "./src/db/directory-schema.ts", "./src/db/app-session-schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://smz:smz@localhost:5432/smz_identity",
  },
  strict: true,
  verbose: true,
});
