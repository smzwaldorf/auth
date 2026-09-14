export const developmentIdentities = {
  schoolAdmin: { id: "d0000000-0000-4000-8000-000000000003", email: "admin@smzwaldorf.com", name: "School Development Admin", role: "admin", invitationId: "d1000000-0000-4000-8000-000000000003" },
  schoolTeacher: { id: "d0000000-0000-4000-8000-000000000004", email: "teacher@smzwaldorf.com", name: "School Development Teacher", role: "teacher", invitationId: "d1000000-0000-4000-8000-000000000004" },
  admin: { id: "d0000000-0000-4000-8000-000000000001", email: "dev.admin@smz.example.test", name: "Development Admin", role: "admin", invitationId: "d1000000-0000-4000-8000-000000000001" },
  parent: { id: "d0000000-0000-4000-8000-000000000002", email: "dev.parent@smz.example.test", name: "Development Parent", role: "parent", invitationId: "d1000000-0000-4000-8000-000000000002" },
} as const;
export function isDevelopmentIdentity(id: string): boolean {
  return Object.values(developmentIdentities).some((identity) => identity.id === id);
}
export type DevelopmentConfig = { NODE_ENV: string; ENABLE_DEV_LOGIN: string; DEV_LOGIN_DATABASE_NAME: string; DATABASE_URL: string; AUTH_ISSUER: string };
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function developmentLoginEnabled(config: DevelopmentConfig): boolean {
  try {
    const issuer = new URL(config.AUTH_ISSUER);
    const database = new URL(config.DATABASE_URL);
    const name = database.pathname.slice(1);
    return config.NODE_ENV === "development" && config.ENABLE_DEV_LOGIN === "true" &&
      issuer.protocol === "http:" && loopbackHosts.has(issuer.hostname) &&
      ["postgres:", "postgresql:"].includes(database.protocol) && loopbackHosts.has(database.hostname) &&
      /_(dev|test)$/.test(name) && name === config.DEV_LOGIN_DATABASE_NAME;
  } catch { return false; }
}
export function localDevelopmentRequest(config: DevelopmentConfig, request: Request, remoteAddress?: string): boolean {
  if (!developmentLoginEnabled(config) || !remoteAddress || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) return false;
  const origin = new URL(config.AUTH_ISSUER).origin;
  if (new URL(request.url).origin !== origin || request.headers.get("host") !== new URL(origin).host) return false;
  // Never trust forwarding headers: this feature is for a direct loopback listener.
  for (const key of request.headers.keys()) if (key === "forwarded" || key.startsWith("x-forwarded-") || key === "x-real-ip") return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !(request.method === "GET" ? ["same-origin", "same-site", "none"] : ["same-origin", "none"]).includes(fetchSite)) return false;
  return request.method === "GET" || (request.method === "POST" && request.headers.get("origin") === origin);
}
