export type AppConfig = { AUTH_ISSUER: string; APP_A_ORIGIN: string; APP_B_ORIGIN: string; APP_B_CLIENT_SECRET: string; APP_B_COOKIE_SECRET: string; production: boolean };
export function parseConfig(env: Record<string, unknown>, production: boolean): AppConfig {
  const config: AppConfig = {
    AUTH_ISSUER: String(env.AUTH_ISSUER || "http://localhost:3000/api/auth"),
    APP_A_ORIGIN: String(env.APP_A_ORIGIN || "http://localhost:5173"),
    APP_B_ORIGIN: String(env.APP_B_ORIGIN || "http://localhost:4000"),
    APP_B_CLIENT_SECRET: String(env.APP_B_CLIENT_SECRET || "local-app-b-client-secret-change-me"),
    APP_B_COOKIE_SECRET: String(env.APP_B_COOKIE_SECRET || "local-app-b-cookie-secret-change-me"), production,
  };
  for (const key of ["AUTH_ISSUER", "APP_A_ORIGIN", "APP_B_ORIGIN"] as const) {
    const url = new URL(config[key]);
    if (url.username || url.password || url.search || url.hash || url.pathname !== (key === "AUTH_ISSUER" ? "/api/auth" : "/")) throw new Error(`Invalid ${key}`);
    if (production && (url.protocol !== "https:" || /localhost|127\.0\.0\.1|\.example\.com$/.test(url.hostname))) throw new Error(`${key} must be a real HTTPS URL`);
  }
  if (production) for (const key of ["APP_B_CLIENT_SECRET", "APP_B_COOKIE_SECRET"] as const) {
    if (!env[key] || config[key].length < 32 || /local-|change-me|placeholder/i.test(config[key])) throw new Error(`${key} must be an explicit secret of at least 32 characters`);
  }
  return config;
}
