import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import { applications, oauthClient, oauthClientResource, oauthResource, auditEvents, session } from "../db/schema.js";
import { runtimeUrls, type RuntimeConfig } from "../runtime-config.js";
import { AdminError } from "./model.js";
import { isAdmin } from "./service.js";
import { siteOrigin } from "./sites.js";
import { escape, layout, pageHead } from "./views.js";

export const registrationInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  site: z.string().trim().max(2048),
  clientType: z.enum(["public", "confidential"]),
  callback: z.string().trim().max(2048),
  logout: z.string().trim().max(2048),
}).superRefine((value, ctx) => {
  const origin = siteOrigin(value.site);
  let safe = false;
  if (origin) { const url = new URL(origin); safe = url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
  if (!safe) ctx.addIssue({ code: "custom", path: ["site"], message: "Use an HTTPS site origin, or HTTP localhost for development." });
  for (const field of ["callback", "logout"] as const) {
    try {
      const url = new URL(value[field]);
      if (url.origin !== origin || url.username || url.password || url.hash || value[field].includes("*")) throw new Error();
    } catch { ctx.addIssue({ code: "custom", path: [field], message: "Use an exact URL on this site, without credentials, fragments, or wildcards." }); }
  }
});
export function registrationService(db: Database, config: RuntimeConfig) {
  async function create(actorId: string, sessionId: string, input: z.infer<typeof registrationInput>) {
    const data = registrationInput.parse(input), clientId = `app-${randomBytes(12).toString("hex")}`;
    const secret = data.clientType === "confidential" ? randomBytes(32).toString("base64url") : undefined;
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [live] = await tx.select().from(session).where(and(eq(session.id, sessionId), eq(session.userId, actorId), sql`${session.expiresAt} > now()`));
      if (!live || !(await isAdmin(tx, config, actorId))) throw new AdminError("Administrator access is no longer active.", 403);
      const now = new Date();
      await tx.insert(oauthClient).values({ id: randomUUID(), clientId, clientSecret: secret ? createHash("sha256").update(secret).digest("base64url") : null,
        name: data.displayName, uri: siteOrigin(data.site)!, disabled: false, skipConsent: true, enableEndSession: true,
        scopes: ["openid", "profile", "email", "directory:access", "offline_access"],
        redirectUris: [new URL(data.callback).href], postLogoutRedirectUris: [new URL(data.logout).href],
        tokenEndpointAuthMethod: secret ? "client_secret_post" : "none", applicationType: "web", type: "web", public: !secret,
        requirePKCE: true, grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], metadata: { clientId }, createdAt: now, updatedAt: now });
      await tx.insert(applications).values({ clientId, displayName: data.displayName, publicOrigin: siteOrigin(data.site)!, enabled: true });
      await tx.insert(oauthResource).values({ id: randomUUID(), identifier: runtimeUrls(config).directoryAudience, name: "SMZ Directory API", allowedScopes: ["openid", "profile", "email", "directory:access", "offline_access"], accessTokenTtl: 900, refreshTokenTtl: 2592000, disabled: false, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: oauthResource.identifier });
      await tx.insert(oauthClientResource).values({ id: randomUUID(), clientId, resourceId: runtimeUrls(config).directoryAudience, createdAt: now });
      await tx.insert(auditEvents).values({ eventType: "admin.application.created", actor: actorId, clientId, detail: { siteOrigin: siteOrigin(data.site), clientType: data.clientType } });
    });
    return { clientId, secret };
  }
  async function get(clientId: string) {
    const [row] = await db.select({ clientId: applications.clientId, displayName: applications.displayName, origin: applications.publicOrigin, callback: oauthClient.redirectUris, logout: oauthClient.postLogoutRedirectUris, public: oauthClient.public }).from(applications).innerJoin(oauthClient, eq(applications.clientId, oauthClient.clientId)).where(eq(applications.clientId, clientId));
    return row;
  }
  return { create, get };
}
export function registrationView(values: Record<string, unknown> = {}, error = "") {
  const field = (name: string, label: string, placeholder: string) => `<label for="${name}">${label}</label><input style="width:100%" id="${name}" name="${name}" required maxlength="${name === "displayName" ? 120 : 2048}" type="${name === "displayName" ? "text" : "url"}" value="${escape(String(values[name] || ""))}" placeholder="${placeholder}">`;
  const wrap = (name: string, label: string, placeholder: string, hint: string) => `<div class="field">${field(name, label, placeholder)}<small>${hint}</small></div>`;
  return layout("Register application", `${pageHead({ crumbs: [["Applications", "/admin/applications"], ["Register application"]], eyebrow: "New OIDC client", title: "Register application", lede: "Connect a website to SMZ Identity. Register development and production URLs separately." })}${error ? `<div class="notice error" role="alert">${escape(error)}</div>` : ""}<div class="split"><form class="card" method="post" action="/admin/applications/register">${wrap("displayName", "Application name", "School portal", "Shown in the launcher and on consent screens.")}${wrap("site", "Site URL", "https://portal.example.com", "Website origin without a path. HTTPS required except for localhost.")}<div class="field"><label for="clientType">Application type</label><select id="clientType" name="clientType"><option value="public">Browser app — no secret</option><option value="confidential" ${values.clientType === "confidential" ? "selected" : ""}>Server app — private client secret</option></select><small>Choose server app when your backend handles the callback and stores credentials.</small></div>${wrap("callback", "Sign-in callback URL", "https://portal.example.com/auth/callback", "Exact URL on the site above.")}${wrap("logout", "After sign-out URL", "https://portal.example.com/", "Where users land after central sign-out.")}<div class="actions"><button>Create application</button><a class="btn ghost" href="/admin/applications">Cancel</a></div></form><section class="card"><h2>What you get</h2><p class="lede">A PKCE S256 authorization-code client with the directory resource permission, plus ready-to-copy OIDC settings. Server secrets are shown once and stored only as a hash.</p><p class="muted">All approved, active users can access the new application immediately. No per-user grants are needed.</p></section></div>`, true, "applications");
}
export function setupView(row: NonNullable<Awaited<ReturnType<ReturnType<typeof registrationService>["get"]>>>, config: RuntimeConfig, secret?: string) {
  const urls = runtimeUrls(config);
  const settings = { issuer: config.AUTH_ISSUER, client_id: row.clientId, redirect_uri: row.callback[0], post_logout_redirect_uri: row.logout?.[0], response_type: "code", scope: "openid profile email directory:access offline_access", resource: urls.directoryAudience, token_endpoint_auth_method: row.public ? "none" : "client_secret_post", ...(secret ? { client_secret: secret } : {}) };
  return layout("Application setup", `${pageHead({ crumbs: [["Applications", "/admin/applications"], [row.displayName]], eyebrow: "OIDC settings", title: row.displayName, lede: `Client <strong>${escape(row.clientId)}</strong> · ${row.public ? "Browser app" : "Server app"} · <a href="${escape(row.origin ?? "")}" target="_blank" rel="noopener noreferrer">${escape(row.origin ?? "")}</a>` })}${secret ? '<div class="notice warn" role="alert">Save the client secret now in your server secret store. It is shown only in this response. Never include it in browser code.</div>' : !row.public ? '<div class="notice info">The client secret is not retrievable. Use the secret saved when this client was created.</div>' : ""}<div class="split"><section class="card"><h2>Settings</h2><p class="lede">Use these in your application's OIDC library.</p><pre class="card" style="margin:0">${escape(JSON.stringify(settings, null, 2))}</pre></section><section class="card"><h2>Integration steps</h2><ol class="steps"><li>Configure your OIDC library with these settings and PKCE S256. Validate state, nonce, issuer, audience, and token signatures.</li><li>Implement the registered callback route to complete sign-in.</li><li>All approved, active users have access automatically. <a href="/admin/users">Manage users and login approval</a> centrally; enforce application-specific permissions in your app.</li><li>After sign-in, call <code>${escape(urls.directoryAudience)}/me/access-context</code> with the access token. Enforce the returned access and handle revoked or expired sessions.</li><li>Test sign-in, refresh, access revocation, and sign-out. Your app owns its local session and permissions.</li></ol><p class="muted">Discovery: <code>${escape(urls.authOrigin)}/.well-known/oauth-authorization-server/api/auth</code></p><p class="muted">Local examples: browser integration in <code>apps/vite-app</code>; server integration in <code>apps/express-app</code>.</p></section></div>`, true, "applications");
}
