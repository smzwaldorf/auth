import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const defaultDatabaseUrl = "postgres://smz:smz@localhost:5432/smz_identity";
const defaultBetterAuthSecret = "local-better-auth-secret-change-me-32-chars";
const defaultAppBClientSecret = "local-app-b-client-secret-change-me";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default(defaultDatabaseUrl),
  AUTH_ISSUER: z.string().url().default("http://localhost:3000/api/auth"),
  AUTH_LISTEN_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TAILSCALE_HOST: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().regex(/^[a-zA-Z0-9.-]+$/, "TAILSCALE_HOST must be a hostname or IPv4 address without a scheme or port").optional(),
  ),
  TAILSCALE_IP: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().regex(/^\d{1,3}(?:\.\d{1,3}){3}$/, "TAILSCALE_IP must be an IPv4 address").optional(),
  ),
  TAILSCALE_AUTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8443),
  TAILSCALE_APP_A_PORT: z.coerce.number().int().min(1).max(65_535).default(8445),
  TAILSCALE_APP_B_PORT: z.coerce.number().int().min(1).max(65_535).default(8444),
  BETTER_AUTH_SECRET: z.string().min(32).default(defaultBetterAuthSecret),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  MAGIC_LINK_DELIVERY_WEBHOOK_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional(),
  ),
  MAGIC_LINK_DELIVERY_WEBHOOK_TOKEN: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().optional(),
  ),
  DEV_LOGIN_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  APP_B_CLIENT_SECRET: z.string().min(16).default(defaultAppBClientSecret),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== "production") return;

  const requireProductionValue = (key: keyof typeof value, placeholder?: string) => {
    const configured = value[key];
    if (!configured || (placeholder !== undefined && configured === placeholder)) {
      context.addIssue({ code: "custom", path: [key], message: `${key} must be explicitly configured for production` });
    }
  };

  if (new URL(value.AUTH_ISSUER).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["AUTH_ISSUER"], message: "AUTH_ISSUER must use HTTPS in production" });
  }
  requireProductionValue("DATABASE_URL", defaultDatabaseUrl);
  requireProductionValue("BETTER_AUTH_SECRET", defaultBetterAuthSecret);
  requireProductionValue("GOOGLE_CLIENT_ID");
  requireProductionValue("GOOGLE_CLIENT_SECRET");
  requireProductionValue("MAGIC_LINK_DELIVERY_WEBHOOK_URL");
  requireProductionValue("MAGIC_LINK_DELIVERY_WEBHOOK_TOKEN");
  requireProductionValue("APP_B_CLIENT_SECRET", defaultAppBClientSecret);
  if (value.DEV_LOGIN_ENABLED) {
    context.addIssue({ code: "custom", path: ["DEV_LOGIN_ENABLED"], message: "DEV_LOGIN_ENABLED must be false in production" });
  }
});

export function parseConfig(environment: NodeJS.ProcessEnv) {
  return configSchema.parse(environment);
}

export const config = parseConfig(process.env);
export const projectRootPath = projectRoot;

export const authOrigin = new URL(config.AUTH_ISSUER).origin;
export const authPort = config.AUTH_LISTEN_PORT;
export const directoryAudience = new URL("/api/directory/v1", authOrigin).href.replace(/\/$/, "");
export const trustedClientIds = new Set(["vite-app", "express-app", "email-cms"]);
export const developmentLoginEnabled = config.NODE_ENV !== "production" && config.DEV_LOGIN_ENABLED;

const configuredAuthHost = new URL(config.AUTH_ISSUER).hostname;
export const publicBrowserHosts = new Set(
  ["localhost", "127.0.0.1", configuredAuthHost, config.TAILSCALE_HOST, config.TAILSCALE_IP].filter((host): host is string => Boolean(host)),
);
export const trustedBrowserOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:4000",
  ...(config.TAILSCALE_HOST ? [`https://${config.TAILSCALE_HOST}:${config.TAILSCALE_APP_A_PORT}`, `https://${config.TAILSCALE_HOST}:${config.TAILSCALE_APP_B_PORT}`] : []),
  ...(config.TAILSCALE_IP ? [`http://${config.TAILSCALE_IP}:5173`, `http://${config.TAILSCALE_IP}:4000`] : []),
  authOrigin,
]);

export function isSupportedPublicHost(host: string): boolean {
  return publicBrowserHosts.has(host.toLowerCase());
}

export function publicPortForHost(host: string, localPort: number): number {
  if (host.toLowerCase() !== config.TAILSCALE_HOST?.toLowerCase()) return localPort;
  if (localPort === authPort) return config.TAILSCALE_AUTH_PORT;
  if (localPort === 5173) return config.TAILSCALE_APP_A_PORT;
  if (localPort === 4000) return config.TAILSCALE_APP_B_PORT;
  return localPort;
}

export function originForHost(host: string, port: number): string {
  if (!isSupportedPublicHost(host)) throw new Error(`Unsupported public host: ${host}`);
  const destination = new URL("http://localhost");
  if (host.toLowerCase() === config.TAILSCALE_HOST?.toLowerCase()) destination.protocol = "https:";
  destination.hostname = host;
  destination.port = String(publicPortForHost(host, port));
  return destination.origin;
}
