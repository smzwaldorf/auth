import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { and, eq, inArray } from "drizzle-orm";
import { createAuthClient } from "better-auth/client";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { createAuditRecorder } from "./audit-service.js";
import { createAuth } from "./auth-factory.js";
import { runtimeUrls, type RuntimeConfig } from "./runtime-config.js";
import type { Database } from "./db/database.js";
import { applications, oauthClient } from "./db/schema.js";
import { createDirectory } from "./directory/service.js";
import { hasOnlyExpectedAudiences } from "./directory/token-policy.js";
import { appBLogoutUrl, parseLogoutReturn } from "./logout-coordinator.js";

export function createApp(config: RuntimeConfig, db: Database) {
  const { authOrigin, directoryAudience, trustedClientIds } = runtimeUrls(config);
  const auth = createAuth(config, db);
  const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  const recordAuditEvent = createAuditRecorder(db);
  const { getAccessContext } = createDirectory(db);
  const resourceClient = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });
  const app = new Hono();

  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    })[character] ?? character);
  }

  function appLaunchUrl(publicOrigin: string | null, redirectUris: string[]): string | null {
    for (const candidate of [publicOrigin, ...redirectUris]) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
      } catch {
        // Ignore invalid stored URLs instead of rendering an unsafe link.
      }
    }
    return null;
  }

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin || origin === authOrigin) return next();
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

  app.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const linkedApps = await db
      .select({
        clientId: applications.clientId,
        displayName: applications.displayName,
        publicOrigin: applications.publicOrigin,
        redirectUris: oauthClient.redirectUris,
        public: oauthClient.public,
      })
      .from(applications)
      .innerJoin(oauthClient, eq(applications.clientId, oauthClient.clientId))
      .where(and(
        eq(applications.enabled, true),
        eq(oauthClient.disabled, false),
        inArray(applications.clientId, [...trustedClientIds]),
      ))
      .orderBy(applications.displayName);

    const appCards = linkedApps.flatMap((linkedApp) => {
      const launchUrl = appLaunchUrl(linkedApp.publicOrigin, linkedApp.redirectUris);
      if (!launchUrl) return [];
      const displayName = escapeHtml(linkedApp.displayName);
      const clientType = linkedApp.public ? "Public client" : "Server-side client";
      return [`<li><div><strong>${displayName}</strong><span>${clientType}</span></div><a href="${escapeHtml(launchUrl)}">Open app <span aria-hidden="true">→</span></a></li>`];
    }).join("");

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps · SMZ Identity</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#28211d;background:#f2eee8}*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:32px 20px;background:radial-gradient(circle at 10% 0%,#f0ddd0,transparent 38%),#f2eee8}main{width:min(100%,680px);margin:8vh auto 0;padding:36px;border:1px solid #ddd2c8;border-radius:24px;background:#fff;box-shadow:0 24px 70px #3827181f}header{margin-bottom:30px}.eyebrow{display:block;margin-bottom:7px;color:#8c7669;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}h1{margin:0 0 10px;font-size:32px;letter-spacing:-.04em}p{margin:0;color:#75675d;line-height:1.55}ul{display:grid;gap:12px;margin:0;padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px;border:1px solid #e6dbd3;border-radius:15px;background:#fcfaf8}li div{display:grid;gap:4px}li strong{font-size:17px}li span{color:#8c7669;font-size:13px}li a{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;padding:11px 14px;border-radius:10px;color:#fff;background:#8b3e25;text-decoration:none;font-weight:750}li a span{color:inherit;font-size:16px}.empty{padding:18px;border:1px dashed #d8c9bf;border-radius:15px}@media(max-width:520px){main{padding:26px}li{align-items:flex-start;flex-direction:column}li a{width:100%;justify-content:center}}</style></head><body><main><header><span class="eyebrow">SMZ Identity</span><h1>Available applications</h1><p>Choose an application to continue. Sign-in happens only after an application requests it.</p></header>${appCards ? `<ul>${appCards}</ul>` : '<p class="empty">No applications are currently available.</p>'}</main><script>if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then((registrations)=>Promise.all(registrations.map((registration)=>registration.unregister())))}</script></body></html>`);
  });

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
    const query = new URL(c.req.url).searchParams;
    if (!query.has("client_id")) return c.redirect("/");
    const oauthQuery = new URL(c.req.url).search.slice(1);
    const googleHref = `/sign-in/google?oauth_query=${encodeURIComponent(oauthQuery)}`;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:520px;margin:12vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}a{display:inline-flex;padding:13px 18px;border-radius:12px;color:#fff;background:#8b3e25;text-decoration:none;font-weight:700}.note{color:#75675d}</style></head><body><main><h1>Sign in to SMZ</h1><p>Use the exact verified Google email pre-approved by the school directory.</p>${googleConfigured ? `<a href="${googleHref}">Continue with Google</a>` : '<p><strong>Google credentials are not configured.</strong></p>'}<p class="note">Students cannot sign in in version 1.</p></main></body></html>`);
  });

  app.get("/sign-in/google", async (c) => {
    if (!googleConfigured) return c.json({ error: "google_not_configured" }, 503);
    const oauthQuery = c.req.query("oauth_query");
    if (!oauthQuery) return c.redirect("/");
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
    const responseHeaders = new Headers({ location: appBLogoutUrl(returnTo, config.APP_B_ORIGIN) });
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
      const payload = await resourceClient.verifyBearerToken(token, {
        verifyOptions: { audience: directoryAudience, issuer: config.AUTH_ISSUER },
        requiredScopes: ["directory:access"],
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

  return app;
}
