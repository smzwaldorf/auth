import { z } from "zod";

const origin = z.string().url().refine((value) => new URL(value).origin === value, "Use an origin without a trailing slash or path");
const schema = z.object({
  MAGIC_LINK_ENABLED: z.enum(["true", "false"]).default("true"),
  MAGIC_LINK_FROM: z.string().refine(v => v === "Aida <info@useaida.app>", "Use the approved sender").default("Aida <info@useaida.app>"),
  RESEND_API_KEY: z.string().default(""),
  STAGING_ADMIN_EMAIL: z.string().trim().toLowerCase().default(""),
  STAGING_PARENT_EMAIL: z.string().trim().toLowerCase().default(""),
  ENABLE_DEV_LOGIN: z.enum(["true", "false"]).default("false"),
  DEV_LOGIN_DATABASE_NAME: z.string().default(""),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://smz:smz@localhost:5432/smz_identity"),
  AUTH_ISSUER: z.string().url().default("http://localhost:3000/api/auth"),
  APP_A_ORIGIN: origin.default("http://localhost:5173"),
  APP_B_ORIGIN: origin.default("http://localhost:4000"),
  CMS_ORIGIN: origin.optional(),
  BETTER_AUTH_SECRET: z.string().min(32).default("local-better-auth-secret-change-me-32-chars"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  APP_B_CLIENT_SECRET: z.string().min(16).default("local-app-b-client-secret-change-me"),
});
export type RuntimeConfig = z.infer<typeof schema>;
export function parseRuntimeConfig(input: Record<string, unknown>): RuntimeConfig {
  const config = schema.parse(input);
  if (config.STAGING_ADMIN_EMAIL || config.STAGING_PARENT_EMAIL || (config.NODE_ENV === "production" && config.MAGIC_LINK_ENABLED === "true")) {
    z.email().parse(config.STAGING_ADMIN_EMAIL);
    z.email().parse(config.STAGING_PARENT_EMAIL);
    if (config.STAGING_ADMIN_EMAIL === config.STAGING_PARENT_EMAIL) throw new Error("Select two distinct staging identities");
  }
  if (config.NODE_ENV === "production" && config.MAGIC_LINK_ENABLED === "true" && !config.RESEND_API_KEY.startsWith("re_")) throw new Error("Configure RESEND_API_KEY before enabling magic links");
  const issuer = new URL(config.AUTH_ISSUER);
  if (issuer.pathname !== "/api/auth" || issuer.search || issuer.hash || issuer.username || issuer.password) throw new Error("AUTH_ISSUER must end exactly in /api/auth");
  if (config.NODE_ENV === "production") {
    for (const key of ["AUTH_ISSUER", "APP_A_ORIGIN", "APP_B_ORIGIN"] as const) {
      const url = new URL(config[key]);
      if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname) || url.hostname.endsWith(".example.com")) throw new Error(`${key} must be a real HTTPS production URL`);
    }
    if (config.CMS_ORIGIN && (new URL(config.CMS_ORIGIN).protocol !== "https:" || /localhost|127\.0\.0\.1|\.example\.com$/.test(new URL(config.CMS_ORIGIN).hostname))) throw new Error("CMS_ORIGIN must be a real HTTPS production origin");
    for (const key of ["BETTER_AUTH_SECRET", "APP_B_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
      if (!input[key] || !config[key] || /local-|change-me|placeholder/i.test(config[key])) throw new Error(`${key} must be explicitly configured for production`);
    }
  }
  return config;
}
export function runtimeUrls(config: RuntimeConfig) {
  const authOrigin = new URL(config.AUTH_ISSUER).origin;
  return { authOrigin, directoryAudience: `${authOrigin}/api/directory/v1`, trustedClientIds: new Set(["smz-admin", "vite-app", "express-app", ...(config.CMS_ORIGIN ? ["email-cms", "email-cms-server"] : [])]) };
}
