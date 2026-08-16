import process from "node:process";

import { serve } from "@hono/node-server";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { and, eq } from "drizzle-orm";
import { createAuthClient } from "better-auth/client";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { recordAuditEvent } from "./audit.js";
import { auth, googleConfigured } from "./auth.js";
import { authOrigin, authPort, config, directoryAudience } from "./config.js";
import { closeDatabase, db } from "./db/client.js";
import { applications } from "./db/schema.js";
import { getAccessContext } from "./directory/access-context.js";
import { hasOnlyExpectedAudiences } from "./directory/token-policy.js";
import { appBLogoutUrl, parseLogoutReturn } from "./logout-coordinator.js";

const resourceClient = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });
const app = new Hono();

app.use("*", secureHeaders());
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin) return next();
  const [registered] = await db
    .select({ clientId: applications.clientId })
    .from(applications)
    .where(and(eq(applications.publicOrigin, origin), eq(applications.enabled, true)))
    .limit(1);
  if (!registered) return c.json({ error: "origin_not_registered" }, 403);
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

app.get("/", (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:720px;margin:10vh auto;padding:36px;border:1px solid #ddd2c8;border-radius:24px;background:#fff}h1{margin-top:0}a{color:#8b3e25}code{background:#f6f2ee;padding:3px 6px;border-radius:5px}</style></head><body><main><h1>SMZ Identity</h1><p>Persistent Hono + Better Auth identity provider and single-school directory.</p><p>Google: <strong>${googleConfigured ? "configured" : "not configured"}</strong></p><p>Issuer: <code>${config.AUTH_ISSUER}</code></p><p><a href="http://localhost:5173">Vite App A</a> · <a href="http://localhost:4000">Express App B</a></p></main></body></html>`),
);

app.get("/health", async (c) => {
  await db.execute("select 1");
  return c.json({ ok: true, issuer: config.AUTH_ISSUER, googleConfigured, database: "postgresql" });
});

app.get("/.well-known/oauth-protected-resource/smz-directory", (c) =>
  c.json({
    resource: directoryAudience,
    authorization_servers: [config.AUTH_ISSUER],
    scopes_supported: ["directory:access"],
    bearer_methods_supported: ["header"],
  }),
);

app.get("/sign-in", (c) => {
  const oauthQuery = new URL(c.req.url).search.slice(1);
  const googleHref = `/sign-in/google?oauth_query=${encodeURIComponent(oauthQuery)}`;
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:520px;margin:12vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}a{display:inline-flex;padding:13px 18px;border-radius:12px;color:#fff;background:#8b3e25;text-decoration:none;font-weight:700}.note{color:#75675d}</style></head><body><main><h1>Sign in to SMZ</h1><p>Use the exact verified Google email pre-approved by the school directory.</p>${googleConfigured ? `<a href="${googleHref}">Continue with Google</a>` : '<p><strong>Google credentials are not configured.</strong></p>'}<p class="note">Students cannot sign in in version 1.</p></main></body></html>`);
});

app.get("/sign-in/google", async (c) => {
  if (!googleConfigured) return c.json({ error: "google_not_configured" }, 503);
  const oauthQuery = c.req.query("oauth_query");
  if (!oauthQuery) return c.json({ error: "missing_oauth_query" }, 400);
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  // This same-origin GET is converted into Better Auth's POST endpoint below.
  // Top-level browser navigation does not send Origin, so supply the trusted
  // auth-service origin explicitly for Better Auth's CSRF origin check.
  headers.set("origin", authOrigin);
  const response = await auth.handler(
    new Request(`${config.AUTH_ISSUER}/sign-in/social`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "google",
        callbackURL: `${authOrigin}/`,
        errorCallbackURL: `${authOrigin}/sign-in?error=google`,
        oauth_query: oauthQuery,
      }),
    }),
  );
  if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
    const result = await response.clone().json() as { redirect?: boolean; url?: string };
    if (result.redirect && result.url) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("location", result.url);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-type");
      return new Response(null, { status: 302, headers: responseHeaders });
    }
  }
  return response;
});

app.get("/logout-all/:returnTo", async (c) => {
  const returnTo = parseLogoutReturn(c.req.param("returnTo"));
  if (!returnTo) return c.json({ error: "invalid_logout_return" }, 400);

  const headers = new Headers(c.req.raw.headers);
  headers.set("origin", authOrigin);
  const signOut = await auth.handler(
    new Request(`${config.AUTH_ISSUER}/sign-out`, { method: "POST", headers }),
  );
  const responseHeaders = new Headers({ location: appBLogoutUrl(returnTo) });
  const clearedSessionCookies = (signOut.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [signOut.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const cookie of clearedSessionCookies) responseHeaders.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers: responseHeaders });
});

app.get("/consent", (c) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consent · SMZ Identity</title></head><body><main><h1>Application access</h1><p>This screen is a fallback; seeded first-party clients normally skip consent.</p><form method="post"><button name="accept" value="true">Allow</button><button name="accept" value="false">Deny</button></form></main></body></html>`),
);

app.post("/consent", async (c) => {
  const body = await c.req.parseBody();
  const oauthQuery = new URL(c.req.url).search.slice(1);
  return auth.api.oauth2Consent({
    body: { accept: body.accept === "true", oauth_query: oauthQuery },
    headers: c.req.raw.headers,
    asResponse: true,
  });
});

app.get("/api/directory/v1/me/access-context", async (c) => {
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  try {
    const payload = await resourceClient.verifyAccessToken(token, {
      verifyOptions: { audience: directoryAudience, issuer: config.AUTH_ISSUER },
      scopes: ["directory:access"],
      resourceMetadataMappings: {
        [directoryAudience]: `${authOrigin}/.well-known/oauth-protected-resource/smz-directory`,
      },
    });
    const personId = typeof payload.sub === "string" ? payload.sub : undefined;
    const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
    if (
      !personId ||
      !clientId ||
      !hasOnlyExpectedAudiences(payload.aud, directoryAudience, `${config.AUTH_ISSUER}/oauth2/userinfo`)
    ) return c.json({ error: "invalid_token_context" }, 401);
    const context = await getAccessContext(personId, clientId);
    if (!context) {
      await recordAuditEvent({ eventType: "directory.access.denied", actor: "directory-api", personId, clientId });
      return c.json({ error: "access_revoked" }, 403);
    }
    return c.json(context, 200, { "Cache-Control": "private, no-store" });
  } catch (error) {
    return c.json({ error: "invalid_access_token", message: error instanceof Error ? error.message : "Token verification failed" }, 401);
  }
});

async function handleAuthRequest(request: Request): Promise<Response> {
  const response = await auth.handler(request);
  const origin = request.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

app.on(["GET", "POST"], "/api/auth/*", (c) => handleAuthRequest(c.req.raw));
app.on(["GET", "POST"], "/.well-known/oauth-authorization-server/api/auth", (c) => handleAuthRequest(c.req.raw));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "internal_server_error" }, 500);
});

const server = serve({ fetch: app.fetch, port: authPort }, () => {
  console.log(`SMZ Identity listening on ${authOrigin}`);
  console.log(`OIDC issuer: ${config.AUTH_ISSUER}`);
});

async function shutdown() {
  server.close();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
