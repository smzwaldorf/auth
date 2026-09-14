import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth-factory.js";
import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { db, closeDatabase } from "../../src/db/client.js";
import { loginInvitations, verification, user, personRoles } from "../../src/db/schema.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
import { validateDirectorySeed } from "../../src/seed/model.js";
import type { LoginMail } from "../../src/magic-link/mail.js";
const seed = validateDirectorySeed(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "seeds/directory.seed.example.json"), "utf8")));
const testConfig = { ...config, MAGIC_LINK_ENABLED: "true" as const };
const outbox: LoginMail[] = [];
const auth = createAuth(testConfig, db, undefined, async mail => { outbox.push(mail); });
const origin = new URL(config.AUTH_ISSUER).origin;
const email = seed.people[0]!.loginEmail!;
const personId = seed.people[0]!.id;
async function signedQuery(clientId = "vite-app") {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: clientId === "vite-app" ? "http://localhost:5173/callback" : "http://localhost:4000/auth/callback", scope: "openid profile email directory:access offline_access", resource: `${origin}/api/directory/v1`, state: "magic-state", nonce: "magic-nonce", code_challenge: createHash("sha256").update("v".repeat(64)).digest("base64url"), code_challenge_method: "S256" });
  const response = await auth.handler(new Request(`${config.AUTH_ISSUER}/oauth2/authorize?${query}`));
  return new URL(response.headers.get("location")!, origin).search.slice(1);
}
async function requestLink(target = email, clientId = "vite-app") {
  return auth.handler(new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: target, oauth_query: await signedQuery(clientId) }) }));
}
const redeem = (url: string) => auth.handler(new Request(url, { headers: { accept: "text/html" } }));
describe.runIf(process.env.RUN_DB_TESTS === "true").sequential("magic links", () => {
  beforeAll(async () => applyDirectorySeed(seed));
  beforeEach(async () => {
    outbox.length = 0;
    await db.delete(verification).where(like(verification.identifier, "magic-throttle:%"));
    await db.update(loginInvitations).set({ status: "pending", expiresAt: null }).where(eq(loginInvitations.personId, personId));
  });
  afterAll(closeDatabase);
  it.each(["vite-app", "express-app"])("completes %s code exchange with a delivered single-use link", async clientId => {
    expect((await requestLink(email, clientId)).status).toBe(200);
    expect(outbox).toHaveLength(1);
    const url = outbox[0]!.url;
    const token = new URL(url).searchParams.get("token")!;
    expect(await db.select().from(verification).where(eq(verification.identifier, token))).toHaveLength(0);
    const response = await redeem(url);
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("session_token");
    const resume = await auth.handler(new Request(response.headers.get("location")!, { headers: { cookie: cookie.split(";")[0]! } }));
    const callback = new URL(resume.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("magic-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: code!, code_verifier: "v".repeat(64), redirect_uri: clientId === "vite-app" ? "http://localhost:5173/callback" : "http://localhost:4000/auth/callback", ...(clientId === "express-app" ? { client_secret: config.APP_B_CLIENT_SECRET } : {}) });
    const tokens = await auth.handler(new Request(`${config.AUTH_ISSUER}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
    expect(tokens.status).toBe(200);
    expect(await tokens.json()).toMatchObject({ access_token: expect.any(String), id_token: expect.any(String), refresh_token: expect.any(String) });
    expect((await redeem(url)).headers.get("set-cookie") || "").not.toContain("session_token");
  });
  it("permits only one concurrent redemption across auth instances", async () => {
    await requestLink();
    const second = createAuth(testConfig, db);
    const responses = await Promise.all([redeem(outbox[0]!.url), second.handler(new Request(outbox[0]!.url))]);
    expect(responses.filter(r => r.headers.get("set-cookie")?.includes("session_token"))).toHaveLength(1);
  });
  it("fails closed for unselected staging accounts and never assigns roles", async () => {
    const restricted = createAuth({ ...testConfig, STAGING_ADMIN_EMAIL: "admin@example.invalid", STAGING_PARENT_EMAIL: "parent@example.invalid" }, db, undefined, async mail => { outbox.push(mail); });
    const query = await signedQuery();
    const response = await restricted.handler(new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, oauth_query: query }) }));
    expect(response.status).toBe(200);
    expect(outbox).toHaveLength(0);
    expect((await db.select().from(personRoles).where(eq(personRoles.personId, personId))).map(r => r.role).sort()).toEqual(["parent", "teacher"]);
  });
  it("rejects forged OAuth continuation before delivery", async () => {
    const response = await auth.handler(new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, oauth_query: "client_id=vite-app&sig=forged" }) }));
    expect(response.status).toBe(400);
    expect(outbox).toHaveLength(0);
  });
  it("reports delivery failure and rejects foreign origins", async () => {
    const failing = createAuth(testConfig, db, undefined, async () => { throw new Error("private provider detail"); });
    const body = JSON.stringify({ email, oauth_query: await signedQuery() });
    const request = (requestOrigin: string) => new Request(`${config.AUTH_ISSUER}/sign-in/magic-link`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body });
    expect((await failing.handler(request("https://foreign.example"))).status).toBe(403);
    const response = await failing.handler(request(origin));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private provider detail");
  });
  it("rejects expired links", async () => {
    await requestLink();
    const token = new URL(outbox[0]!.url).searchParams.get("token")!;
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.identifier, createHash("sha256").update(token).digest("base64url")));
    expect((await redeem(outbox[0]!.url)).headers.get("location")).toContain("INVALID_TOKEN");
  });
  it("rejects access revoked between delivery and redemption", async () => {
    await requestLink();
    await db.update(loginInvitations).set({ status: "revoked" }).where(eq(loginInvitations.personId, personId));
    expect((await redeem(outbox[0]!.url)).headers.get("set-cookie") || "").not.toContain("session_token");
  });
  it("does not send to or provision unknown identities and throttles resend", async () => {
    expect((await requestLink("unknown@example.invalid")).status).toBe(200);
    expect(outbox).toHaveLength(0);
    expect(await db.select().from(user).where(eq(user.email, "unknown@example.invalid"))).toHaveLength(0);
    expect((await requestLink("unknown@example.invalid")).status).toBe(429);
  });
  it("rejects all password routes even for well-formed credentials", async () => {
    for (const route of ["sign-in/email", "sign-up/email", "set-password", "change-password", "reset-password", "request-password-reset", "forget-password"]) {
      const response = await auth.handler(new Request(`${config.AUTH_ISSUER}/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password: "not-a-real-password", name: "Test", newPassword: "not-a-real-password", currentPassword: "not-a-real-password", token: "invalid" }) }));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(outbox).toHaveLength(0);
  });
  it("renders the email form alongside Google and preserves OAuth continuation", async () => {
    const app = createApp({ ...testConfig, GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test" }, db, async mail => { outbox.push(mail); });
    const query = await signedQuery();
    const html = await (await app.request(`${origin}/sign-in?${query}`)).text();
    expect(html).toContain('name="email"');
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain('type="password"');
    const response = await app.request(`${origin}/sign-in/magic-link`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, oauth_query: query }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Check your email");
    expect(outbox).toHaveLength(1);
  });
});
