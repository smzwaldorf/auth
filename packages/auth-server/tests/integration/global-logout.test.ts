import { serve } from "@hono/node-server";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth-factory.js";
import { config as baseConfig } from "../../src/config.js";
import { runtimeUrls } from "../../src/runtime-config.js";
import { db, closeDatabase } from "../../src/db/client.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
const config = { ...baseConfig, CMS_ORIGIN: "http://localhost:5174" };
const { directoryAudience, trustedClientIds } = runtimeUrls(config);
const app = createApp(config, db), auth = createAuth(config, db);
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthAccessToken, oauthRefreshToken, session, user } from "../../src/db/schema.js";
import { validateDirectorySeed } from "../../src/seed/model.js";
function requireTestDatabase() {
 const url = new URL(config.DATABASE_URL);
 if (!process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/smz_identity") throw new Error("Requires explicit disposable local smz_identity database");
}

const enabled = process.env.RUN_DB_TESTS === "true";
const baseline = validateDirectorySeed(JSON.parse(fs.readFileSync("seeds/directory.seed.example.json", "utf8")));
for (const client of baseline.applications) client.frontChannelLogoutUri = `${client.publicOrigin}/logout/local`;
const cms = validateDirectorySeed({ version: 1, school: baseline.school, people: [], families: [], classes: [], appAccess: [], applications: [{ clientId: "email-cms", displayName: "CMS", clientType: "public", publicOrigin: config.CMS_ORIGIN, redirectUris: [`${config.CMS_ORIGIN}/auth/callback`], postLogoutRedirectUris: [`${config.CMS_ORIGIN}/login`], frontChannelLogoutUri: `${config.CMS_ORIGIN}/logout/local`, scopes: ["openid", "profile", "email", "directory:access", "offline_access"] }] });
const adultId = baseline.people[0]!.id;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
let server: ReturnType<typeof serve>;
let nodeOrigin: string;
const request = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
  const headers = new Headers(init.headers);
  const body = init.body?.toString();
  if (init.body instanceof URLSearchParams) headers.set("content-type", "application/x-www-form-urlencoded");
  const req = httpRequest(new URL(path, nodeOrigin), { method: init.method ?? "GET", headers: Object.fromEntries(headers) }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => {
      const responseHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
    });
  });
  req.on("error", reject);
  req.end(body);
});
async function centralSession() {
  const current = await (await auth.$context).internalAdapter.createSession(adultId);
  if (!current) throw new Error("Expected central session");
  const signature = createHmac("sha256", config.BETTER_AUTH_SECRET).update(current.token).digest("base64");
  return { ...current, cookie: `better-auth.session_token=${encodeURIComponent(`${current.token}.${signature}`)}` };
}
async function issue(clientId: string, cookie: string) {
  const redirect = clientId === "vite-app" ? "http://localhost:5173/callback" : clientId === "express-app" ? "http://localhost:4000/auth/callback" : "http://localhost:5174/auth/callback";
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "openid profile email offline_access directory:access", resource: directoryAudience, state: randomUUID(), nonce: randomUUID(), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const authorize = await request(`/api/auth/oauth2/authorize?${query}`, { headers: { cookie } });
  expect(authorize.status).toBe(302);
  const target = new URL(authorize.headers.get("location")!);
  expect(target.origin + target.pathname).toBe(redirect);
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code: target.searchParams.get("code")!, code_verifier: verifier, resource: directoryAudience });
  if (clientId === "express-app") body.set("client_secret", config.APP_B_CLIENT_SECRET);
  const response = await request("/api/auth/oauth2/token", { method: "POST", body });
  expect(response.status).toBe(200);
  return { ...await response.json() as { access_token: string; refresh_token: string }, clientId };
}
async function access(token: string) { return request("/api/directory/v1/me/access-context", { headers: { authorization: `Bearer ${token}` } }); }
async function refresh(token: { refresh_token: string; clientId: string }) {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: token.clientId, refresh_token: token.refresh_token, resource: directoryAudience });
  if (token.clientId === "express-app") body.set("client_secret", config.APP_B_CLIENT_SECRET);
  return request("/api/auth/oauth2/token", { method: "POST", body });
}

describe.runIf(enabled).sequential("linked-application central logout", () => {
  beforeAll(async () => { requireTestDatabase(); nodeOrigin = new URL(config.AUTH_ISSUER).origin; await new Promise<void>(resolve => { server = serve({ fetch: app.fetch, port: Number(new URL(config.AUTH_ISSUER).port || 3000), hostname: "127.0.0.1" }, () => resolve()); }); });
  beforeEach(async () => {
    requireTestDatabase();
    baseline.people[0]!.invitation!.status = "activated";
    await applyDirectorySeed(baseline);
    if (trustedClientIds.has("email-cms")) {
      await applyDirectorySeed(cms);
      const { appAccess } = await import("../../src/db/schema.js");
      await db.insert(appAccess).values({ personId: adultId, clientId: "email-cms", status: "active" }).onConflictDoUpdate({ target: [appAccess.personId, appAccess.clientId], set: { status: "active" } });
    }
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, adultId));
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await closeDatabase(); });
  it.each(["vite-app", "express-app", ...(trustedClientIds.has("email-cms") ? ["email-cms"] : [])])("%s initiation revokes every linked grant for this sid, preserving another device", async (initiator) => {
    const current = await centralSession(), other = await centralSession();
    const tokens = [];
    for (const clientId of trustedClientIds) tokens.push(await issue(clientId, current.cookie));
    const otherToken = await issue("vite-app", other.cookie);
    const response = await request(`/logout-all/${initiator}`, { headers: { cookie: current.cookie } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const html = await response.text();
    for (const clientId of trustedClientIds) expect(html).toContain(`"clientId":"${clientId}"`);
    for (const token of tokens) {
      expect((await access(token.access_token)).status).toBe(403);
      const userInfo = await request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } });
      expect([401, 403]).toContain(userInfo.status);
      expect((await refresh(token)).status).toBe(400);
    }
    expect(await (await request("/api/auth/get-session", { headers: { cookie: current.cookie } })).json()).toBeNull();
    expect(await db.select().from(session).where(eq(session.id, current.id))).toHaveLength(0);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.sessionId, current.id))).toHaveLength(0);
    expect(await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.sessionId, current.id))).toHaveLength(0);
    expect((await access(otherToken.access_token)).status).toBe(200);
    expect((await refresh(otherToken)).status).toBe(200);
  });
  it("rejects unknown returns before revocation and excludes disabled CMS", async () => {
    const current = await centralSession();
    expect((await request("/logout-all/not-registered?returnTo=https://attacker.example", { headers: { cookie: current.cookie } })).status).toBe(400);
    expect(await db.select().from(session).where(eq(session.id, current.id))).toHaveLength(1);
    if (!trustedClientIds.has("email-cms")) {
      await applyDirectorySeed(cms);
      const response = await request("/logout-all/app-a", { headers: { cookie: current.cookie } });
      expect(await response.text()).not.toContain('"clientId":"email-cms"');
    }
  });
  it("does not claim success when central revocation fails", async () => {
    const current = await centralSession();
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("simulated database failure"));
    const response = await request("/logout-all/app-a", { headers: { cookie: current.cookie } });
    transaction.mockRestore();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("Your central session and its application credentials have been revoked");
    expect(await db.select().from(session).where(eq(session.id, current.id))).toHaveLength(1);
  });
});
