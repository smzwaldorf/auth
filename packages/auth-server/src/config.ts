import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://smz:smz@localhost:5432/smz_identity"),
  AUTH_ISSUER: z.string().url().default("http://localhost:3000/api/auth"),
  BETTER_AUTH_SECRET: z.string().min(32).default("local-better-auth-secret-change-me-32-chars"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  APP_B_CLIENT_SECRET: z.string().min(16).default("local-app-b-client-secret-change-me"),
});

export const config = configSchema.parse(process.env);
export const projectRootPath = projectRoot;

export const authOrigin = new URL(config.AUTH_ISSUER).origin;
export const authPort = Number(new URL(config.AUTH_ISSUER).port || 3000);
export const directoryAudience = new URL("/api/directory/v1", authOrigin).href.replace(/\/$/, "");
export const trustedClientIds = new Set(["vite-app", "express-app"]);
