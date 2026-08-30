import process from "node:process";
import { randomUUID } from "node:crypto";

import { serve } from "@hono/node-server";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { and, eq } from "drizzle-orm";
import { createAuthClient } from "better-auth/client";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { recordAuditEvent } from "./audit.js";
import {
  activeAdminForUser,
  activeAdminInvitationForEmail,
  activeDevelopmentLoginForUser,
  activeInvitationForEmail,
  activeInvitationForUser,
  auth,
  cancelDevelopmentMagicLink,
  googleConfigured,
  listActiveDevelopmentLogins,
  waitForDevelopmentMagicLink,
} from "./auth.js";
import { listPeopleForAdmin, manageableRoles, updatePersonFromAdmin } from "./admin.js";
import { authOrigin, authPort, config, directoryAudience, isSupportedPublicHost, originForHost, trustedBrowserOrigins } from "./config.js";
import { closeDatabase, db } from "./db/client.js";
import { applications } from "./db/schema.js";
import { getAccessContext } from "./directory/access-context.js";
import { hasOnlyExpectedAudiences } from "./directory/token-policy.js";
import { appBLogoutUrl, parseLogoutReturn } from "./logout-coordinator.js";
import { getSignInFeedback, oauthQueryForSignInPage } from "./sign-in-status.js";

const resourceClient = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });
const app = new Hono();

app.use("*", secureHeaders());
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin) return next();
  const [registered] = trustedBrowserOrigins.has(origin)
    ? [true]
    : await db
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

function publicHost(c: { req: { url: string } }): string | null {
  try {
    const host = new URL(c.req.url).hostname;
    return isSupportedPublicHost(host) ? host : null;
  } catch {
    return null;
  }
}

function appOriginForRequest(c: { req: { url: string } }, port: number): string {
  const host = publicHost(c);
  return host ? originForHost(host, port) : authOrigin;
}

app.get("/", (c) => {
  const viteOrigin = appOriginForRequest(c, 5173);
  const expressOrigin = appOriginForRequest(c, 4000);
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:720px;margin:10vh auto;padding:36px;border:1px solid #ddd2c8;border-radius:24px;background:#fff}h1{margin-top:0}a{color:#8b3e25}code{background:#f6f2ee;padding:3px 6px;border-radius:5px}</style></head><body><main><h1>SMZ Identity</h1><p>Persistent Hono + Better Auth identity provider and single-school directory.</p><p>Google: <strong>${googleConfigured ? "configured" : "not configured"}</strong></p><p>Issuer: <code>${config.AUTH_ISSUER}</code></p><p><a href="${viteOrigin}">Vite App A</a> · <a href="${expressOrigin}">Express App B</a></p></main></body></html>`);
});

app.get("/health", async (c) => {
  await db.execute("select 1");
  return c.json({
    ok: true,
    issuer: config.AUTH_ISSUER,
    googleConfigured,
    database: "postgresql",
    magicLink: config.NODE_ENV === "production"
      ? (config.MAGIC_LINK_DELIVERY_WEBHOOK_URL ? "webhook" : "not_configured")
      : "development-console",
  });
});

app.get("/.well-known/oauth-protected-resource/smz-directory", (c) =>
  c.json({
    resource: directoryAudience,
    authorization_servers: [config.AUTH_ISSUER],
    scopes_supported: ["directory:access"],
    bearer_methods_supported: ["header"],
  }),
);

function signInUrl(oauthQuery: string, status?: string): string {
  const destination = new URL("/sign-in", authOrigin);
  destination.searchParams.set("oauth_query", oauthQuery);
  if (status) destination.searchParams.set("status", status);
  return `${destination.pathname}${destination.search}`;
}

function authorizeCallbackUrl(oauthQuery: string): string {
  return `${config.AUTH_ISSUER}/oauth2/authorize?${oauthQuery}`;
}

function adminSignInUrl(status?: string): string {
  const destination = new URL("/admin/sign-in", authOrigin);
  if (status) destination.searchParams.set("status", status);
  return `${destination.pathname}${destination.search}`;
}

function adminUrl(status?: string): string {
  const destination = new URL("/admin", authOrigin);
  if (status) destination.searchParams.set("status", status);
  return `${destination.pathname}${destination.search}`;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;",
  })[character] ?? character);
}

function sameOrigin(c: { req: { header: (name: string) => string | undefined; url: string } }): boolean {
  const requestOrigin = appOriginForRequest(c, authPort);
  const origin = c.req.header("origin");
  if (origin) return origin === authOrigin || origin === requestOrigin;
  const referer = c.req.header("referer");
  try {
    const refererOrigin = referer ? new URL(referer).origin : undefined;
    return refererOrigin === authOrigin || refererOrigin === requestOrigin;
  } catch {
    return false;
  }
}

async function forwardMagicLinkRequest(input: {
  email: string;
  callbackURL: string;
  errorCallbackURL: string;
  metadata?: Record<string, string>;
}): Promise<Response> {
  return auth.handler(
    new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: authOrigin },
      body: JSON.stringify(input),
    }),
  );
}

async function currentAdmin(c: { req: { raw: Request } }): Promise<{ personId: string; email: string } | null> {
  try {
    const authSession = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!authSession?.user?.id || !authSession.user.email || !(await activeAdminForUser(authSession.user.id))) return null;
    return { personId: authSession.user.id, email: authSession.user.email };
  } catch {
    return null;
  }
}

function renderAdminSignIn(status?: string, providerError?: string): string {
  const feedback = getSignInFeedback(status, providerError);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administrator sign in · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:520px;margin:12vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}a,button{display:inline-flex;padding:13px 18px;border:0;border-radius:12px;color:#fff;background:#4e385f;text-decoration:none;font:700 16px system-ui;cursor:pointer}.note{color:#75675d}.status{padding:12px 14px;border-radius:10px}.status-info{background:#eef6ec;color:#235d35}.status-error{background:#fceeee;color:#822b2b}form{display:grid;gap:12px;margin-top:18px}label{display:grid;gap:6px;font-weight:650}input{padding:11px 12px;border:1px solid #cdbfb5;border-radius:9px;font:inherit}</style></head><body><main><h1>SMZ administrator sign in</h1><p>Only active directory administrators can access user management.</p>${feedback ? `<p class="status status-${feedback.tone}" role="${feedback.tone === "error" ? "alert" : "status"}">${feedback.message}</p>` : ""}${googleConfigured ? '<p><a href="/admin/sign-in/google">Continue with Google</a></p>' : ""}<h2>Use an email link</h2><p class="note">Enter the exact email held by your administrator record.</p><form action="/admin/sign-in/magic-link" method="post"><label>Email address<input name="email" type="email" autocomplete="email" required></label><button type="submit">Email me a sign-in link</button></form><p class="note"><a href="/sign-in" style="padding:0;background:none;color:#4e385f">Return to standard sign in</a></p></main></body></html>`;
}

function renderAdminPanel(input: {
  actorEmail: string;
  people: Awaited<ReturnType<typeof listPeopleForAdmin>>;
  status?: string;
}): string {
  const feedback = input.status === "updated"
    ? '<p class="status status-info" role="status">Person updated. Active sessions and tokens were revoked if the account was disabled.</p>'
    : input.status === "invalid"
      ? '<p class="status status-error" role="alert">The submitted person details were not valid.</p>'
      : input.status === "self-protection"
        ? '<p class="status status-error" role="alert">You cannot disable yourself or remove your own administrator role.</p>'
        : input.status === "forbidden"
          ? '<p class="status status-error" role="alert">This request was not accepted.</p>'
          : "";
  const rows = input.people.map((person) => {
    const roles = manageableRoles.map((role) => {
      const checked = person.roles.includes(role) ? " checked" : "";
      const disabled = person.kind === "student" && role !== "student" ? " disabled" : person.kind === "adult" && role === "student" ? " disabled" : "";
      return `<label class="role"><input type="checkbox" name="roles" value="${role}"${checked}${disabled}> ${role}</label>`;
    }).join("");
    return `<article class="person"><form action="/admin/people/${encodeURIComponent(person.id)}" method="post"><header><strong>${escapeHtml(person.displayName)}</strong><span class="badge ${person.status}">${person.status}</span></header><p>${escapeHtml(person.email ?? "No login email")} · ${person.kind}</p><label>Name<input name="displayName" value="${escapeHtml(person.displayName)}" maxlength="120" required></label><label>Status<select name="status"><option value="active"${person.status === "active" ? " selected" : ""}>Active</option><option value="disabled"${person.status === "disabled" ? " selected" : ""}>Disabled</option></select></label><fieldset><legend>Directory roles</legend>${roles}</fieldset><button type="submit">Save user</button></form></article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Directory administration · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:1100px;margin:6vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}header.top{display:flex;justify-content:space-between;gap:20px;align-items:start}h1{margin:0}.note,p{color:#75675d}.status{padding:12px 14px;border-radius:10px}.status-info{background:#eef6ec;color:#235d35}.status-error{background:#fceeee;color:#822b2b}.people{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-top:24px}.person{padding:20px;border:1px solid #eadfd8;border-radius:16px;background:#fcfaf8}.person header{display:flex;justify-content:space-between;gap:12px}.person p{font-size:14px;overflow-wrap:anywhere}.person form{display:grid;gap:12px}.person label{display:grid;gap:6px;font-weight:650}.person input,.person select{padding:10px 11px;border:1px solid #cdbfb5;border-radius:8px;font:inherit;background:#fff}.person fieldset{display:flex;flex-wrap:wrap;gap:10px;border:1px solid #ded2ca;border-radius:9px}.person .role{display:inline-flex;align-items:center;gap:5px;font-weight:500}.person button,.logout{padding:10px 13px;border:0;border-radius:9px;background:#4e385f;color:#fff;font:700 14px system-ui;cursor:pointer}.badge{padding:3px 7px;border-radius:999px;font-size:12px;font-weight:700}.badge.active{background:#e4f3e9;color:#165c3a}.badge.disabled{background:#fceeee;color:#822b2b}.logout{background:#fff;color:#4e385f;border:1px solid #c9bdcf}@media(max-width:650px){main{margin:0;padding:24px;border-radius:0}header.top{display:grid}}</style></head><body><main><header class="top"><div><p class="note">SMZ Identity</p><h1>Directory administration</h1><p>Signed in as ${escapeHtml(input.actorEmail)}. Changes are audited; disabling a user immediately revokes central sessions and tokens.</p></div><form action="/admin/logout" method="post"><button class="logout" type="submit">Sign out</button></form></header>${feedback}<section class="people" aria-label="Directory people">${rows}</section></main></body></html>`;
}

app.get("/admin/sign-in", async (c) => {
  const admin = await currentAdmin(c);
  if (admin) return c.redirect("/admin");
  return c.html(renderAdminSignIn(c.req.query("status"), c.req.query("error")));
});

app.post("/admin/sign-in/magic-link", async (c) => {
  if (!sameOrigin(c)) return c.redirect(adminSignInUrl("admin-access-denied"));
  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) return c.redirect(adminSignInUrl("invalid-request"));
  const eligible = await activeAdminInvitationForEmail(email);
  if (!eligible) {
    await recordAuditEvent({ eventType: "admin.magic_link.denied", actor: "admin-sign-in", detail: { reason: "not_active_admin" } });
    return c.redirect(adminSignInUrl("magic-link-sent"));
  }
  const response = await forwardMagicLinkRequest({
    email: eligible.authEmail,
    callbackURL: `${authOrigin}/admin`,
    errorCallbackURL: `${authOrigin}${adminSignInUrl("magic-link-failed")}`,
  });
  if (!response.ok) {
    await recordAuditEvent({ eventType: "admin.magic_link.failed", actor: "admin-sign-in", personId: eligible.personId });
    return c.redirect(adminSignInUrl("magic-link-delivery-failed"));
  }
  await recordAuditEvent({ eventType: "admin.magic_link.issued", actor: "admin-sign-in", personId: eligible.personId });
  return c.redirect(adminSignInUrl("magic-link-sent"));
});

app.get("/admin/sign-in/google", async (c) => {
  if (!googleConfigured) return c.redirect(adminSignInUrl("google-unavailable"));
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", authOrigin);
  const response = await auth.handler(
    new Request(`${config.AUTH_ISSUER}/sign-in/social`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "google",
        callbackURL: `${authOrigin}/admin`,
        errorCallbackURL: `${authOrigin}${adminSignInUrl("google-failed")}`,
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

app.get("/admin", async (c) => {
  const admin = await currentAdmin(c);
  if (!admin) return c.redirect(adminSignInUrl("admin-access-denied"));
  return c.html(renderAdminPanel({ actorEmail: admin.email, people: await listPeopleForAdmin(), status: c.req.query("status") }));
});

app.post("/admin/people/:personId", async (c) => {
  if (!sameOrigin(c)) return c.redirect(adminUrl("forbidden"));
  const admin = await currentAdmin(c);
  if (!admin) return c.redirect(adminSignInUrl("admin-access-denied"));
  const body = await c.req.parseBody();
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const status = body.status === "active" || body.status === "disabled" ? body.status : undefined;
  const roles = Array.isArray(body.roles) ? body.roles : typeof body.roles === "string" ? [body.roles] : [];
  const personId = c.req.param("personId");
  if (!displayName || displayName.length > 120 || !status) return c.redirect(adminUrl("invalid"));
  if (personId === admin.personId && (status !== "active" || !roles.includes("admin"))) return c.redirect(adminUrl("self-protection"));
  const updated = await updatePersonFromAdmin({ personId, displayName, status, roles });
  if (!updated) return c.redirect(adminUrl("invalid"));
  await recordAuditEvent({
    eventType: "directory.admin.person.updated",
    actor: `admin:${admin.personId}`,
    personId: updated.id,
    detail: { status: updated.status, roles: updated.roles },
  });
  return c.redirect(adminUrl("updated"));
});

app.post("/admin/logout", async (c) => {
  if (!sameOrigin(c)) return c.redirect(adminSignInUrl("admin-access-denied"));
  const headers = new Headers(c.req.raw.headers);
  headers.set("origin", authOrigin);
  const signOut = await auth.handler(new Request(`${config.AUTH_ISSUER}/sign-out`, { method: "POST", headers }));
  const responseHeaders = new Headers({ location: "/admin/sign-in" });
  const cookies = (signOut.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [signOut.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers: responseHeaders });
});

app.get("/sign-in", async (c) => {
  const requestUrl = new URL(c.req.url);
  const oauthQuery = oauthQueryForSignInPage(requestUrl);
  const googleHref = `/sign-in/google?oauth_query=${encodeURIComponent(oauthQuery)}`;
  const feedback = getSignInFeedback(c.req.query("status"), c.req.query("error"));
  const developmentAccounts = await listActiveDevelopmentLogins();
  const oauthQueryAttribute = oauthQuery
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const magicLinkForm = `<form action="/sign-in/magic-link" method="post"><input type="hidden" name="oauth_query" value="${oauthQueryAttribute}"><label>Email address<input name="email" type="email" autocomplete="email" required></label><button type="submit">Email me a sign-in link</button></form>`;
  const developmentLinks = developmentAccounts.length
    ? `<section class="development"><h2>Development accounts</h2><p>Available only outside production.</p>${developmentAccounts.map((account) => `<a href="/sign-in/development/${encodeURIComponent(account.personId)}?oauth_query=${encodeURIComponent(oauthQuery)}">Continue as ${account.label}</a>`).join("")}</section>`
    : "";
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · SMZ Identity</title><style>body{font:16px system-ui;margin:0;background:#f2eee8;color:#28211d}main{max-width:520px;margin:12vh auto;padding:36px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #38271822}a,button{display:inline-flex;padding:13px 18px;border:0;border-radius:12px;color:#fff;background:#8b3e25;text-decoration:none;font:700 16px system-ui;cursor:pointer}.note{color:#75675d}.status{padding:12px 14px;border-radius:10px}.status-info{background:#eef6ec;color:#235d35}.status-error{background:#fceeee;color:#822b2b}form{display:grid;gap:12px;margin-top:18px}label{display:grid;gap:6px;font-weight:650}input{padding:11px 12px;border:1px solid #cdbfb5;border-radius:9px;font:inherit}.development{display:grid;gap:10px;margin-top:28px;padding-top:22px;border-top:1px solid #eadfd8}.development h2{font-size:16px;margin:0}.development p{margin:0;color:#75675d}.development a{background:#5d6f85}</style></head><body><main><h1>Sign in to SMZ</h1><p>Only active parents and teachers approved by the school can sign in.</p>${feedback ? `<p class="status status-${feedback.tone}" role="${feedback.tone === "error" ? "alert" : "status"}">${feedback.message}</p>` : ""}${googleConfigured ? `<p><a href="${googleHref}">Continue with Google</a></p>` : ""}<h2>Use an email link</h2><p class="note">Enter the exact email recorded by the school directory.</p>${magicLinkForm}${developmentLinks}<p class="note">Students cannot sign in.</p></main></body></html>`);
});

app.post("/sign-in/magic-link", async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email : "";
  const oauthQuery = typeof body.oauth_query === "string" ? body.oauth_query : "";
  if (!sameOrigin(c)) return c.redirect(signInUrl(oauthQuery, "invalid-request"));
  if (!email || !oauthQuery) return c.redirect(signInUrl(oauthQuery, "invalid-request"));

  const eligible = await activeInvitationForEmail(email);
  if (!eligible) {
    await recordAuditEvent({ eventType: "identity.magic_link.denied", actor: "sign-in", detail: { reason: "not_eligible" } });
    return c.redirect(signInUrl(oauthQuery, "magic-link-sent"));
  }
  const response = await forwardMagicLinkRequest({
    email: eligible.authEmail,
    callbackURL: authorizeCallbackUrl(oauthQuery),
    errorCallbackURL: `${authOrigin}${signInUrl(oauthQuery, "magic-link-failed")}`,
  });
  if (response.ok) {
    await recordAuditEvent({ eventType: "identity.magic_link.issued", actor: "sign-in", personId: eligible.personId });
    return c.redirect(signInUrl(oauthQuery, "magic-link-sent"));
  }
  await recordAuditEvent({ eventType: "identity.magic_link.failed", actor: "sign-in", personId: eligible.personId });
  return c.redirect(signInUrl(oauthQuery, "magic-link-delivery-failed"));
});

app.get("/sign-in/development/:personId", async (c) => {
  const oauthQuery = c.req.query("oauth_query");
  if (!oauthQuery) return c.redirect(signInUrl("", "invalid-request"));
  const developmentAccount = await activeDevelopmentLoginForUser(c.req.param("personId"));
  if (!developmentAccount) return c.redirect(signInUrl(oauthQuery, "development-login-unavailable"));
  const activeInvitation = await activeInvitationForUser(developmentAccount.personId);
  if (!activeInvitation) return c.redirect(signInUrl(oauthQuery, "development-login-unavailable"));

  const requestId = randomUUID();
  const magicLink = waitForDevelopmentMagicLink(requestId);
  void magicLink.catch(() => undefined);
  try {
    const magicLinkResponse = await forwardMagicLinkRequest({
      email: activeInvitation.authEmail,
      callbackURL: authorizeCallbackUrl(oauthQuery),
      errorCallbackURL: `${authOrigin}${signInUrl(oauthQuery, "magic-link-failed")}`,
      metadata: { developmentLoginRequestId: requestId },
    });
    if (!magicLinkResponse.ok) return c.redirect(signInUrl(oauthQuery, "development-login-unavailable"));
    const url = await magicLink;
    await recordAuditEvent({ eventType: "identity.development_login", actor: "development", personId: developmentAccount.personId });
    return c.redirect(url);
  } catch (error) {
    return c.redirect(signInUrl(oauthQuery, "development-login-unavailable"));
  } finally {
    cancelDevelopmentMagicLink(requestId);
  }
});

app.get("/sign-in/google", async (c) => {
  const oauthQuery = c.req.query("oauth_query");
  if (!oauthQuery) return c.redirect(signInUrl("", "invalid-request"));
  if (!googleConfigured) return c.redirect(signInUrl(oauthQuery, "google-unavailable"));
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
        // Better Auth returns here only after it has established the central
        // session. Resume the original signed OIDC authorization request so
        // the calling app receives its authorization code.
        callbackURL: authorizeCallbackUrl(oauthQuery),
        errorCallbackURL: `${authOrigin}${signInUrl(oauthQuery, "google-failed")}`,
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
  const responseHeaders = new Headers({ location: appBLogoutUrl(appOriginForRequest(c, 4000), returnTo) });
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

const server = serve({ fetch: app.fetch, port: authPort, hostname: "0.0.0.0" }, () => {
  console.log(`SMZ Identity listening on ${authOrigin}`);
  console.log(`OIDC issuer: ${config.AUTH_ISSUER}`);
});

async function shutdown() {
  server.close();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
