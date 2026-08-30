import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const defaultClientSecret = "local-app-b-client-secret-change-me";
const defaultCookieSecret = "local-app-b-cookie-secret-change-me";
const defaultDatabaseUrl = "postgres://smz:smz@localhost:5432/smz_identity";

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return parsed;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = environment.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("NODE_ENV must be development, test, or production");

  const issuer = new URL(environment.AUTH_ISSUER ?? "http://localhost:3000/api/auth");
  const clientSecret = environment.APP_B_CLIENT_SECRET ?? defaultClientSecret;
  const cookieSecret = environment.APP_B_COOKIE_SECRET ?? defaultCookieSecret;
  const databaseUrl = environment.DATABASE_URL ?? defaultDatabaseUrl;
  const isProduction = nodeEnv === "production";

  if (clientSecret.length < 16) throw new Error("APP_B_CLIENT_SECRET must contain at least 16 characters");
  if (cookieSecret.length < 32) throw new Error("APP_B_COOKIE_SECRET must contain at least 32 characters");
  if (isProduction) {
    if (issuer.protocol !== "https:") throw new Error("AUTH_ISSUER must use HTTPS in production");
    if (clientSecret === defaultClientSecret) throw new Error("APP_B_CLIENT_SECRET must be explicitly configured in production");
    if (cookieSecret === defaultCookieSecret) throw new Error("APP_B_COOKIE_SECRET must be explicitly configured in production");
    if (databaseUrl === defaultDatabaseUrl) throw new Error("DATABASE_URL must be explicitly configured in production");
  }

  return {
    nodeEnv,
    isProduction,
    issuer,
    clientSecret,
    cookieSecret,
    databaseUrl,
    listenPort: port(environment.APP_B_LISTEN_PORT, 4000, "APP_B_LISTEN_PORT"),
    tailnetHost: environment.TAILSCALE_HOST?.toLowerCase(),
    tailnetIp: environment.TAILSCALE_IP,
    tailnetPorts: {
      auth: port(environment.TAILSCALE_AUTH_PORT, 8443, "TAILSCALE_AUTH_PORT"),
      appA: port(environment.TAILSCALE_APP_A_PORT, 8445, "TAILSCALE_APP_A_PORT"),
      appB: port(environment.TAILSCALE_APP_B_PORT, 8444, "TAILSCALE_APP_B_PORT"),
    },
  };
}

export const appConfig = loadAppConfig();
