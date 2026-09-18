import { layout } from "./admin/views.js";
import { adminAuthorizationUrl } from "./admin/sign-in.js";
import { browserSignInError, signInErrorPage } from "./sign-in-error.js";
import { adminRoutes } from "./admin/routes.js";
import { bodyLimit } from "hono/body-limit";
import type { LoginMailer } from "./magic-link/mail.js";
import { isAPIError } from "better-auth/api";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { and, eq } from "drizzle-orm";
import { createAuthClient } from "better-auth/client";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { createAuditRecorder } from "./audit-service.js";
import { centralSessionState } from "./global-logout.js";
import { createAuth } from "./auth-factory.js";
import { runtimeUrls, type RuntimeConfig } from "./runtime-config.js";
import type { Database } from "./db/database.js";
import { applications, oauthClient } from "./db/schema.js";
import { createDirectory } from "./directory/service.js";
import { hasOnlyExpectedAudiences } from "./directory/token-policy.js";
import { logoutPlan, renderLogoutPage, parseLogoutReturn } from "./logout-coordinator.js";

import { developmentIdentities, localDevelopmentRequest } from "./development/policy.js";

export function createApp(config: RuntimeConfig, db: Database, mailer?: LoginMailer) {
  const { authOrigin, directoryAudience } = runtimeUrls(config);
  const localDevelopmentRequests = new WeakSet<Request>();
  const auth = createAuth(config, db, localDevelopmentRequests, mailer);
  const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  const recordAuditEvent = createAuditRecorder(db);
  const { getAccessContext, getDirectoryContext, getDeliveryContacts } = createDirectory(db, config);
  const resourceClient = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });
  const app = new Hono<{ Bindings: { transport?: { remoteAddress?: string } } }>();

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

  app.use("*", (c, next) => secureHeaders({ referrerPolicy: (c.req.path === "/sign-in" || c.req.path === "/admin" || c.req.path.startsWith("/admin/")) ? "same-origin" : c.req.path.startsWith("/logout-all/") ? "origin" : "no-referrer" })(c, next));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("*", async (c, next) => {
    if (localDevelopmentRequest(config, c.req.raw, c.env?.transport?.remoteAddress)) localDevelopmentRequests.add(c.req.raw);
    if (/\/sign-in\/development\/?$/i.test(c.req.path) && !localDevelopmentRequests.has(c.req.raw)) return c.json({ error: "not_found" }, 404);
    return next();
  });
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

  app.route("/admin", adminRoutes(db, config, auth));

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
      ))
      .orderBy(applications.displayName);

    const appCards = linkedApps.flatMap((linkedApp) => {
      const launchUrl = appLaunchUrl(linkedApp.publicOrigin, linkedApp.redirectUris);
      if (!launchUrl) return [];
      const displayName = escapeHtml(linkedApp.displayName);
      const descriptions: Record<string, string> = {
        "vite-app": "Try school sign-in in a browser app",
        "express-app": "Try school sign-in in a server app",
        "email-cms": "Read and manage school newsletters",
        "smz-admin": "Manage school accounts and applications",
      };
      const description = descriptions[linkedApp.clientId] || "Connect with your school account";
      return [`<li><div><strong>${displayName}</strong><span>${escapeHtml(description)}</span></div><a href="${escapeHtml(launchUrl)}">Open <span aria-hidden="true">→</span></a></li>`];
    }).join("");

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps · SMZ Identity</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#28211d;background:#f2eee8}*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:32px 20px;background:radial-gradient(circle at 10% 0%,#f0ddd0,transparent 38%),#f2eee8}main{width:min(100%,680px);margin:8vh auto 0;padding:36px;border:1px solid #ddd2c8;border-radius:24px;background:#fff;box-shadow:0 24px 70px #3827181f}header{margin-bottom:30px}.eyebrow{display:block;margin-bottom:7px;color:#8c7669;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}h1{margin:0 0 10px;font-size:32px;letter-spacing:-.04em}p{margin:0;color:#75675d;line-height:1.55}ul{display:grid;gap:12px;margin:0;padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px;border:1px solid #e6dbd3;border-radius:15px;background:#fcfaf8}li div{display:grid;gap:4px}li strong{font-size:17px}li span{color:#8c7669;font-size:13px}li a{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;padding:11px 14px;border-radius:10px;color:#fff;background:#8b3e25;text-decoration:none;font-weight:750}li a span{color:inherit;font-size:16px}.empty{padding:18px;border:1px dashed #d8c9bf;border-radius:15px}@media(max-width:520px){main{padding:26px}li{align-items:flex-start;flex-direction:column}li a{width:100%;justify-content:center}}</style></head><body><main><header><span class="eyebrow">SMZ Identity</span><a href="/admin" style="float:right;color:#8b3e25;font-size:14px">Admin Panel</a><h1>School applications</h1><p>Choose an app to get started. Use your school-approved account to sign in when prompted.</p></header>${appCards ? `<ul>${appCards}</ul>` : '<p class="empty">No apps are available yet. Please contact your school administrator.</p>'}</main><script>if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then((registrations)=>Promise.all(registrations.map((registration)=>registration.unregister())))}</script></body></html>`);
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

  app.use("/sign-in/magic-link", bodyLimit({ maxSize: 16384 }));
  app.use("/api/auth/sign-in/magic-link", bodyLimit({ maxSize: 16384 }));
  app.get("/magic-link/error", c => c.html(layout("Sign-in link unavailable", '<section class="card"><h1>This sign-in link is unavailable</h1><p>It may have expired, already been used, or your access may have changed.</p><p>Please request a new link from your application. If you still cannot sign in, contact your school administrator for assistance.</p><a class="button" href="/">Return to school applications</a></section>', false)));
  app.post("/sign-in/magic-link", async c => {
    if (c.req.header("origin") !== authOrigin) return c.json({ error: "origin_not_allowed" }, 403);
    const body = await c.req.parseBody();
    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const response = await auth.handler(new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, {
      method: "POST", headers, body: JSON.stringify({ email: body.email, oauth_query: body.oauth_query }),
    }));
    const ok = response.ok;
    const html = layout(ok ? "Check your email" : "Unable to send link", `<section class="card"><h1>${ok ? "Check your email" : "Unable to send link"}</h1><p>${ok ? "If your email is approved, you will receive a sign-in link. It expires in five minutes and can be used once. Open it in the browser where you started signing in." : "Please wait a minute and request a new link from your application. If you still cannot sign in, contact your school administrator for assistance."}</p><a class="button" href="/">Return to school applications</a></section>`, false);
    const outputHeaders = new Headers(response.headers);
    outputHeaders.set("content-type", "text/html; charset=utf-8");
    outputHeaders.delete("content-length");
    return new Response(html, { status: response.status, headers: outputHeaders });
  });

  app.get("/sign-in/error", c => c.html(signInErrorPage(), 403));
  app.get("/sign-in", async (c) => {
    const query = new URL(c.req.url).searchParams;
    if (query.has("error")) return c.html(signInErrorPage(), 403);
    if (!query.has("client_id") && query.get("admin") === "1") return c.redirect(await adminAuthorizationUrl(db, config), 303);
    if (!query.has("client_id")) return c.redirect("/");
    const oauthQuery = new URL(c.req.url).search.slice(1);
    const googleHref = `/sign-in/google?oauth_query=${encodeURIComponent(oauthQuery)}`;
    const magicForm = config.MAGIC_LINK_ENABLED === "true" ? `<section><h2>Sign in by email</h2><form method="post" action="/sign-in/magic-link"><input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}"><label for="login-email">Approved email address</label><input id="login-email" name="email" type="email" autocomplete="email" required maxlength="254" style="display:block;width:100%;box-sizing:border-box;padding:12px;margin:12px 0"><button type="submit" style="padding:12px 18px">Email me a sign-in link</button></form><p class="note">The link expires in five minutes and works once.</p></section>` : "";
    const developmentButtons = localDevelopmentRequests.has(c.req.raw) && new URLSearchParams(oauthQuery).has("sig")
      ? `<section class="development"><h2>Development only</h2><p class="note">Choose a synthetic account. No email or password required.</p>${Object.entries(developmentIdentities).map(([key, identity]) => `<form method="post" action="/api/auth/sign-in/development"><input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}"><input type="hidden" name="identity" value="${key}"><button class="dev-login" type="submit"><strong>Continue as ${escapeHtml(identity.name)}</strong><span>${escapeHtml(identity.email)} · ${identity.role}</span></button></form>`).join("")}</section>` : "";
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:520px;margin:12vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}a{display:inline-flex;padding:13px 18px;border-radius:12px;color:#fff;background:#8b3e25;text-decoration:none;font-weight:700}.note{color:#75675d}.development{border-top:1px solid #e6dbd3;margin-top:28px;padding-top:18px}.development form{margin:12px 0}.dev-login{display:flex;flex-direction:column;gap:5px;width:100%;padding:16px 18px;border:1px solid #d9c8bb;border-radius:12px;background:#faf6f2;color:#643b28;text-align:left;cursor:pointer;font:inherit}.dev-login:hover{background:#f0e3d8}.dev-login:focus-visible{outline:3px solid #8b3e25;outline-offset:3px}.dev-login span{font-size:13px;color:#75675d}</style></head><body><main><h1>Sign in to SMZ</h1><p>Use the email address pre-approved by the school directory.</p>${googleConfigured ? `<a href="${googleHref}">Continue with Google</a>` : '<p><strong>Google credentials are not configured.</strong></p>'}${magicForm}${developmentButtons}<p class="note">Students cannot sign in in version 1.</p></main></body></html>`);
  });

  app.get("/sign-in/google", async (c) => {
    if (!googleConfigured) return c.html(signInErrorPage(), 503);
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
          errorCallbackURL: `${authOrigin}/sign-in/error`,
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
    return browserSignInError(c.req.raw, response);
  });

app.get("/logout-all/:returnTo", async (c) => {
  const returnClient = parseLogoutReturn(c.req.param("returnTo"));
  if (!returnClient) return c.json({ error: "invalid_logout_return" }, 400);
  const registrations = await db.select({ clientId: applications.clientId, displayName: applications.displayName,
    publicOrigin: applications.publicOrigin, postLogoutRedirectUris: oauthClient.postLogoutRedirectUris, metadata: oauthClient.metadata })
    .from(applications).innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId))
    .where(and(eq(applications.enabled, true), eq(oauthClient.disabled, false)));
  const plan = logoutPlan(registrations, returnClient);
  if (!plan) return c.json({ error: "invalid_logout_return" }, 400);
  const headers = new Headers(c.req.raw.headers);
  headers.set("origin", authOrigin);
  const signOut = await auth.api.signOutLinkedApplications({ headers, asResponse: true });
  if (!signOut.ok) return c.json({ error: "logout_failed" }, 503);
  const responseHeaders = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const cookie of signOut.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
  responseHeaders.set("Content-Security-Policy", `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${[...new Set(plan.targets.map((target) => target.origin))].join(" ") || "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  responseHeaders.set("Referrer-Policy", "origin");
  return new Response(renderLogoutPage(plan, crypto.randomUUID()), { status: 200, headers: responseHeaders });
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

  app.on("GET", ["/api/directory/v1/me/access-context", "/api/directory/v1/me/directory", "/api/directory/v1/me/delivery-contacts"], async (c) => {
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    try {
      const payload = await resourceClient.verifyBearerToken(token, {
        jwksUrl: `${config.AUTH_ISSUER}/jwks`,
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
      const centralState = await centralSessionState(db, personId, payload.sid);
      if (centralState === "revoked") return c.json({ error: "access_revoked" }, 403);
      if (centralState === "expired") return c.json({ error: "session_expired" }, 401);
      const context = await (c.req.path.endsWith("/directory") ? getDirectoryContext(personId, clientId) : getAccessContext(personId, clientId));
      if (!context) {
        await recordAuditEvent({ eventType: "directory.access.denied", actor: "directory-api", personId, clientId });
        return c.json({ error: "access_revoked" }, 403);
      }
      if (c.req.path.endsWith("/delivery-contacts")) {
        if (clientId !== "email-cms-server" || !context.roles.includes("admin")) {
          await recordAuditEvent({ eventType: "directory.delivery.denied", actor: "directory-api", personId, clientId, detail: { reason: "server_admin_required" } });
          return c.json({ error: "delivery_access_denied" }, 403);
        }
        return c.json({
          contractVersion: 1,
          fetchedAt: new Date().toISOString(),
          contacts: await getDeliveryContacts(),
        }, 200, { "Cache-Control": "private, no-store" });
      }
      return c.json(context, 200, { "Cache-Control": "private, no-store" });
    } catch (error) {
      // Invalid bearer errors are distinct from database, JWKS and transport failures.
      if (isAPIError(error) && error.status === "UNAUTHORIZED") return c.json({ error: "invalid_access_token" }, 401);
      if (isAPIError(error) && error.status === "FORBIDDEN") return c.json({ error: "insufficient_scope" }, 403);
      const code = (error as { code?: string })?.code;
      if (typeof code === "string" && (code.startsWith("ERR_JWT_") || code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || code === "ERR_JWS_INVALID")) return c.json({ error: "invalid_access_token" }, 401);
      if (!token) return c.json({ error: "invalid_access_token" }, 401);
      return c.json({ error: "identity_unavailable" }, 503);
    }
  });

  async function handleAuthRequest(request: Request): Promise<Response> {
    const response = browserSignInError(request, await auth.handler(request));
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
