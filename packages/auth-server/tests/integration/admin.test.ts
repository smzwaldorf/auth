import { relationshipInput, relationshipService } from "../../src/admin/relationships.js";
import { centralSessionState } from "../../src/global-logout.js";
import { createDirectory } from "../../src/directory/service.js";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { db, closeDatabase } from "../../src/db/client.js";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth-factory.js";
import { applicationService } from "../../src/admin/application-service.js";
import { adminService } from "../../src/admin/service.js";
import { families, classes, familyMemberships, classMemberships, people, personRoles, user, loginInvitations, session, auditEvents, applications, oauthClient, appAccess, oauthAccessToken, oauthRefreshToken } from "../../src/db/schema.js";
const app = createApp(config, db), auth = createAuth(config, db), service = adminService(db, config);
const accessService = applicationService(db, config);
const origin = new URL(config.AUTH_ISSUER).origin;
let admin: { id: string; cookie: string; sessionId: string }, parent: typeof admin;
async function fixture(role: "admin" | "parent") {
  const id = randomUUID(), email = `${id}@example.test`;
  await db.insert(people).values({ id, kind: "adult", displayName: `Test ${role}`, normalizedLoginEmail: email });
  await db.insert(user).values({ id, name: `Test ${role}`, email, emailVerified: true });
  await db.insert(personRoles).values({ personId: id, role });
  await db.insert(loginInvitations).values({ id: randomUUID(), personId: id, normalizedEmail: email, status: "activated" });
  const current = await (await auth.$context).internalAdapter.createSession(id);
  const signature = createHmac("sha256", config.BETTER_AUTH_SECRET).update(current.token).digest("base64");
  return { id, cookie: `better-auth.session_token=${encodeURIComponent(`${current.token}.${signature}`)}`, sessionId: current.id };
}
function request(path: string, cookie?: string, body?: URLSearchParams, requestOrigin = origin) {
  return app.request(`${origin}${path}`, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" } : {}) }, body });
}
const input = (email = `${randomUUID()}@example.test`) => ({ displayName: "New <script>alert(1)</script>", email, status: "active" as const, roles: ["parent" as const], sites: [], approval: "approved" as const });
const form = (data: ReturnType<typeof input>, version = "") => new URLSearchParams({ displayName: data.displayName, email: data.email, status: data.status, approval: data.approval, roles: data.roles[0]!, version });
describe.runIf(process.env.RUN_DB_TESTS === "true").sequential("admin panel", () => {
  beforeAll(async () => {
    const url = new URL(config.DATABASE_URL);
    if (!process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/smz_magic_test_\d+$/.test(url.pathname)) throw new Error("Admin tests require an explicitly selected disposable local test database");
    admin = await fixture("admin"); parent = await fixture("parent");
  });
  afterAll(closeDatabase);
  it("registers a client through the form and makes it available to OAuth without per-user grant records", async () => {
    const site = `https://${randomUUID()}.example`;
    const body = new URLSearchParams({ displayName: "New portal", site, callback: `${site}/callback`, logout: `${site}/`, clientType: "confidential" });
    expect((await request("/admin/applications/register", parent.cookie, body)).status).toBe(303);
    const response = await request("/admin/applications/register", admin.cookie, body);
    expect(response.status).toBe(201);
    const html = await response.text();
    const clientId = html.match(/app-[a-f0-9]{24}/)![0];
    const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    expect(client?.requirePKCE).toBe(true);
    expect(client?.clientSecret).toBeTruthy();
    expect(html).not.toContain(client!.clientSecret!);
    expect(await db.select().from(appAccess).where(eq(appAccess.clientId, clientId))).toHaveLength(0);
    const setup = await request(`/admin/applications/setup/${clientId}`, admin.cookie);
    expect(await setup.text()).not.toContain('&quot;client_secret&quot;:');
    const authorization = await app.request(`${config.AUTH_ISSUER}/oauth2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: `${site}/callback`, response_type: "code", scope: "openid profile email directory:access", resource: `${origin}/api/directory/v1`, code_challenge: "a".repeat(43), code_challenge_method: "S256", state: randomUUID() })}`);
    expect([302, 303]).toContain(authorization.status);
    expect(authorization.headers.get("location")).toContain("sign-in");
    const context = await auth.$context;
    expect(typeof context.options.trustedOrigins === "function" ? await context.options.trustedOrigins() : []).toContain(site);
    expect(await (await request("/", admin.cookie)).text()).toContain(site);
  });
  it("registers public clients without secrets and rejects cross-site callbacks", async () => {
    const site = `https://${randomUUID()}.example`;
    const body = new URLSearchParams({ displayName: "Browser portal", site, callback: "https://foreign.example/callback", logout: `${site}/`, clientType: "public" });
    expect((await request("/admin/applications/register", admin.cookie, body)).status).toBe(400);
    body.set("callback", `${site}/callback`);
    const response = await request("/admin/applications/register", admin.cookie, body);
    expect(response.status).toBe(201);
    const clientId = (await response.text()).match(/app-[a-f0-9]{24}/)![0];
    const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    expect(client?.clientSecret).toBeNull();
    expect(client?.tokenEndpointAuthMethod).toBe("none");
    expect(client?.public).toBe(true);
    const preflight = await app.request(`${config.AUTH_ISSUER}/get-session`, { method: "OPTIONS", headers: { origin: site } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(site);
    await db.update(oauthClient).set({ disabled: true }).where(eq(oauthClient.clientId, clientId));
    const context = await auth.$context;
    expect(typeof context.options.trustedOrigins === "function" ? await context.options.trustedOrigins() : []).not.toContain(site);
  });
  it("requires authentication and a live admin role", async () => {
    for (const path of ["/admin", "/admin/", "/admin/users/new", "/admin/families", "/admin/students", "/admin/classes", "/admin/applications"]) {
      const response = await request(path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin/sign-in");
    }
    const login = await request("/admin/sign-in");
    expect(login.status).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).toContain('href="/sign-in?admin=1">Sign in</a>');
    expect(loginHtml).not.toContain("<nav>");
    expect((await request("/admin/sign-in", admin.cookie)).headers.get("location")).toBe("/admin");
    expect((await request("/admin/sign-in", parent.cookie)).headers.get("location")).toBe("/admin");
    for (const path of ["/admin/users/new", "/admin/families", "/admin/students", "/admin/classes", "/admin/applications", "/admin/"]) {
      const denied = await request(path, parent.cookie);
      expect(denied.status).toBe(303);
      expect(denied.headers.get("location")).toBe("/admin");
    }
    const deniedPage = await request("/admin", parent.cookie);
    expect(deniedPage.status).toBe(403);
    const deniedHtml = await deniedPage.text();
    expect(deniedHtml).toContain('<h1>Not authenticated</h1>');
    expect(deniedHtml).not.toContain("<nav>");
    const adminPage = await request("/admin", admin.cookie);
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get("referrer-policy")).toBe("same-origin");
  });
  it("opens the shared sign-in service with a fixed admin callback and PKCE", async () => {
    const start = await request("/sign-in?admin=1");
    expect(start.status).toBe(303);
    const authorization = new URL(start.headers.get("location")!);
    expect(authorization.searchParams.get("client_id")).toBe("smz-admin");
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/admin`);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const response = await request(authorization.pathname + authorization.search);
    const loginUrl = new URL(response.headers.get("location")!, origin);
    expect(loginUrl.pathname).toBe("/sign-in");
    expect(loginUrl.searchParams.has("sig")).toBe(true);
    const chooser = await request(loginUrl.pathname + loginUrl.search);
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain("Sign in to SMZ");
  });
  it("lets non-admins sign out without allowing cross-origin logout", async () => {
    const nonAdmin = await fixture("parent");
    const page = await request("/admin", nonAdmin.cookie);
    expect(await page.text()).toContain('action="/admin/sign-out"');
    expect((await request("/admin/sign-out", nonAdmin.cookie, new URLSearchParams(), "https://foreign.example")).status).toBe(403);
    expect((await request("/admin/sign-out", nonAdmin.cookie)).status).toBe(303);
    expect(await centralSessionState(db, nonAdmin.id, nonAdmin.sessionId)).toBe("active");
    const signedOut = await request("/admin/sign-out", nonAdmin.cookie, new URLSearchParams());
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/admin");
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await centralSessionState(db, nonAdmin.id, nonAdmin.sessionId)).toBe("revoked");
    expect((await request("/admin", nonAdmin.cookie)).headers.get("location")).toBe("/admin/sign-in");
  });
  it("rejects missing or foreign mutation origins", async () => {
    expect((await request("/admin/users", admin.cookie, new URLSearchParams(), "https://foreign.example")).status).toBe(403);
    expect((await request("/admin/users", admin.cookie, new URLSearchParams(), "")).status).toBe(403);
  });
  it("creates an unverified, pre-approved adult through the real form route and escapes stored names", async () => {
    const data = input(), body = form(data); body.delete("clients");
    const response = await request("/admin/users", admin.cookie, body);
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    const page = await request(location, admin.cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("&lt;script&gt;");
    const id = location.split("/").pop()!.split("?")[0]!;
    const [created] = await db.select().from(user).where(eq(user.id, id));
    expect(created?.emailVerified).toBe(false);
    expect((await service.detail(id))?.invitation?.status).toBe("pending");
    expect(await db.select().from(auditEvents).where(eq(auditEvents.personId, id))).toHaveLength(1);
    expect((await request("/admin/users", admin.cookie, body)).status).toBe(409);
  });
  it("rejects role tampering and self lockout", async () => {
    const body = form(input()); body.delete("clients"); body.set("roles", "superadmin");
    expect((await request("/admin/users", admin.cookie, body)).status).toBe(400);
    const own = (await service.detail(admin.id))!;
    await expect(service.save(admin.id, admin.sessionId, admin.id, { ...input(own.normalizedLoginEmail!), version: own.updatedAt.toISOString() })).rejects.toThrow("own account");
  });
  it("rejects stale writes, changes access atomically, and invalidates sessions", async () => {
    const target = (await service.detail(parent.id))!;
    const data = { ...input(target.normalizedLoginEmail!), version: target.updatedAt.toISOString() };
    await expect(service.save(admin.id, admin.sessionId, parent.id, { ...data, sites: [{ origin: "https://unknown.example", action: "active" }], catalogVersion: (await service.apps()).version })).rejects.toThrow("Application access is automatic");
    expect(await db.select().from(session).where(eq(session.id, parent.sessionId))).toHaveLength(1);
    await service.save(admin.id, admin.sessionId, parent.id, { ...data, status: "disabled" });
    expect(await db.select().from(session).where(eq(session.id, parent.sessionId))).toHaveLength(0);
    expect((await service.detail(parent.id))?.status).toBe("disabled");
    await expect(service.save(admin.id, admin.sessionId, parent.id, data)).rejects.toThrow("changed since");
  });
  it("searches literal text and filters disabled users", async () => {
    const found = await service.list("<script>", 1, "disabled");
    expect(found.rows.length).toBeGreaterThan(0);
    expect(found.rows.every(row => row.status === "disabled")).toBe(true);
    expect((await service.list("%_no_match", 1, "")).total).toBe(0);
  });
  it("rejects revoked administrator approval and student edits", async () => {
    const revoked = await fixture("admin");
    await db.update(loginInvitations).set({ status: "revoked" }).where(eq(loginInvitations.personId, revoked.id));
    expect((await request("/admin", revoked.cookie)).status).toBe(403);
    const studentId = randomUUID();
    await db.insert(people).values({ id: studentId, kind: "student", displayName: "Read-only student" });
    const student = (await service.detail(studentId))!;
    await expect(service.save(admin.id, admin.sessionId, studentId, { ...input(), version: student.updatedAt.toISOString() })).rejects.toThrow("Only adult");
    const response = await request(`/admin/users/${studentId}`, admin.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin/students/${studentId}`);
    const page = await request(`/admin/students/${studentId}`, admin.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Read-only student");
    expect(html).toContain("Student record · no login account");
    expect(html).not.toContain("Force sign out");
  });
  it("renders the overview, filtered lists and detail pages with relationship context", async () => {
    const overview = await request("/admin", admin.cookie);
    expect(overview.status).toBe(200);
    const overviewHtml = await overview.text();
    expect(overviewHtml).toContain("Needs attention");
    expect(overviewHtml).toContain('aria-current="page"');
    const users = await request("/admin/users?q=Test&role=admin&kind=adult", admin.cookie);
    expect(users.status).toBe(200);
    const usersHtml = await users.text();
    expect(usersHtml).toContain("Test admin");
    expect(usersHtml).not.toContain("Test parent");
    expect((await request("/admin/users?q=Test+parent&role=parent", admin.cookie).then(r => r.text()))).toContain("Test parent");
    expect((await request(`/admin/users?q=${randomUUID()}&kind=student`, admin.cookie).then(r => r.text()))).toContain("No people found");
    expect((await request("/admin/families?id=new", admin.cookie)).headers.get("location")).toBe("/admin/families/new");
    expect((await request("/admin/families/new", admin.cookie)).status).toBe(200);
    expect((await request("/admin/classes/not-a-uuid", admin.cookie)).status).toBe(404);
    expect((await request(`/admin/families/${randomUUID()}`, admin.cookie)).status).toBe(404);
    const me = await request(`/admin/users/${admin.id}`, admin.cookie);
    expect(await me.text()).toContain("Add to a family");
  });
  async function registeredSite(origin: string, ids = [`web-${randomUUID()}`, `server-${randomUUID()}`]) {
    for (const clientId of ids) {
      await db.insert(oauthClient).values({ id: randomUUID(), clientId, redirectUris: [], disabled: false }).onConflictDoNothing();
      await db.insert(applications).values({ clientId, displayName: clientId, publicOrigin: origin }).onConflictDoUpdate({ target: applications.clientId, set: { publicOrigin: origin } });
    }
    return (await accessService.catalog()).sites.find(site => site.origin === origin)!;
  }
  it("admits approved adults to new applications without grants and ignores legacy revocations", async () => {
    const directory = createDirectory(db, config), target = await fixture("parent");
    const site = await registeredSite(`https://${randomUUID()}.example`);
    for (const id of site.clientIds) expect(await directory.hasLiveAppAccess(target.id, id)).toBe(true);
    await db.insert(appAccess).values({ personId: target.id, clientId: site.clientIds[0]!, status: "revoked" });
    expect(await directory.hasLiveAppAccess(target.id, site.clientIds[0]!)).toBe(true);
    expect(await directory.hasLiveAppAccess(target.id, "unknown-client")).toBe(false);
    await db.update(oauthClient).set({ disabled: true }).where(eq(oauthClient.clientId, site.clientIds[0]!));
    expect(await directory.hasLiveAppAccess(target.id, site.clientIds[0]!)).toBe(false);
    await db.update(applications).set({ enabled: false }).where(eq(applications.clientId, site.clientIds[1]!));
    expect(await directory.hasLiveAppAccess(target.id, site.clientIds[1]!)).toBe(false);
  });
  it("blocks disabled users, revoked or expired approval, and students despite automatic application access", async () => {
    const directory = createDirectory(db, config), target = await fixture("parent");
    const site = await registeredSite(`https://${randomUUID()}.example`), id = site.clientIds[0]!;
    await db.update(people).set({ status: "disabled" }).where(eq(people.id, target.id));
    expect(await directory.hasLiveAppAccess(target.id, id)).toBe(false);
    await db.update(people).set({ status: "active" }).where(eq(people.id, target.id));
    await db.update(loginInvitations).set({ status: "revoked" }).where(eq(loginInvitations.personId, target.id));
    expect(await directory.hasLiveAppAccess(target.id, id)).toBe(false);
    await db.update(loginInvitations).set({ status: "activated", expiresAt: new Date(0) }).where(eq(loginInvitations.personId, target.id));
    expect(await directory.hasLiveAppAccess(target.id, id)).toBe(false);
    await db.update(loginInvitations).set({ expiresAt: null }).where(eq(loginInvitations.personId, target.id));
    await db.update(people).set({ kind: "student" }).where(eq(people.id, target.id));
    expect(await directory.hasLiveAppAccess(target.id, id)).toBe(false);
  });
  it("removes obsolete grant controls and rejects stale grant submissions", async () => {
    const page = await request("/admin/applications", admin.cookie);
    const html = await page.text();
    expect(html).toContain("automatically have access");
    expect(html).not.toContain("Grant site access");
    expect((await request("/admin/applications/access", admin.cookie, new URLSearchParams())).status).toBe(409);
    expect(await (await request(`/admin/users/${admin.id}`, admin.cookie)).text()).not.toContain('name="sites"');
  });
  it("force signs out all sessions without changing account status or approval", async () => {
    const target = await fixture("parent"), other = await fixture("parent");
    const second = await (await auth.$context).internalAdapter.createSession(target.id);
    const before = await service.detail(target.id);
    const site = await registeredSite(`https://${randomUUID()}.example`);
    await db.insert(oauthAccessToken).values({ id: randomUUID(), token: randomUUID(), userId: target.id, sessionId: target.sessionId, clientId: site.clientIds[0]!, scopes: ["openid"] });
    await db.insert(oauthRefreshToken).values({ id: randomUUID(), token: randomUUID(), userId: target.id, sessionId: second.id, clientId: site.clientIds[0]!, scopes: ["openid"] });
    const path = `/admin/users/${target.id}/sign-out`;
    expect((await request(path, admin.cookie, new URLSearchParams(), "https://foreign.example")).status).toBe(403);
    expect((await request(path, parent.cookie, new URLSearchParams())).status).toBe(303);
    expect(await centralSessionState(db, target.id, target.sessionId)).toBe("active");
    const response = await request(path, admin.cookie, new URLSearchParams());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("signedOut=1");
    expect(await service.detail(target.id)).toEqual(before);
    expect(await db.select().from(session).where(eq(session.userId, target.id))).toHaveLength(0);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, target.id))).toHaveLength(0);
    expect(await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, target.id))).toHaveLength(0);
    expect(await centralSessionState(db, other.id, other.sessionId)).toBe("active");
    expect(await (await auth.$context).internalAdapter.createSession(target.id)).toBeTruthy();
    const html = await (await request(`/admin/users/${target.id}`, admin.cookie)).text();
    expect(html).toContain("Force sign out");
    expect(html).not.toContain('name="approval"');
    expect((await (await request("/admin/users/new", admin.cookie)).text())).not.toContain("Force sign out");
  });
  it("disabling immediately revokes every session and client token without affecting other users", async () => {
    const target = await fixture("parent"), other = await fixture("parent");
    const second = await (await auth.$context).internalAdapter.createSession(target.id);
    const site = await registeredSite(`https://${randomUUID()}.example`);
    for (const clientId of site.clientIds) {
      await db.insert(oauthAccessToken).values({ id: randomUUID(), token: randomUUID(), userId: target.id, sessionId: target.sessionId, clientId, scopes: ["openid"] });
      await db.insert(oauthRefreshToken).values({ id: randomUUID(), token: randomUUID(), userId: target.id, sessionId: second.id, clientId, scopes: ["openid"] });
    }
    const before = (await service.detail(target.id))!;
    const body = form(input(before.normalizedLoginEmail!), before.updatedAt.toISOString());
    body.set("status", "disabled");
    expect((await request(`/admin/users/${target.id}`, admin.cookie, body)).status).toBe(303);
    expect(await db.select().from(session).where(eq(session.userId, target.id))).toHaveLength(0);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, target.id))).toHaveLength(0);
    expect(await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, target.id))).toHaveLength(0);
    expect(await centralSessionState(db, target.id, target.sessionId)).toBe("revoked");
    expect(await centralSessionState(db, target.id, second.id)).toBe("revoked");
    expect(await auth.api.getSession({ headers: new Headers({ cookie: target.cookie }) })).toBeNull();
    for (const clientId of site.clientIds) expect(await createDirectory(db, config).getAccessContext(target.id, clientId)).toBeNull();
    expect(await centralSessionState(db, other.id, other.sessionId)).toBe("active");
    const revoked = (await service.detail(target.id))!;
    await service.save(admin.id, admin.sessionId, target.id, { ...input(revoked.normalizedLoginEmail!), version: revoked.updatedAt.toISOString() });
    expect(await centralSessionState(db, target.id, target.sessionId)).toBe("revoked");
    expect(await auth.api.getSession({ headers: new Headers({ cookie: target.cookie }) })).toBeNull();
  });
  it("manages parent-family-student-class relationships with live class scopes and history", async () => {
    const relationships = relationshipService(db, config), guardian = await fixture("parent");
    async function save(data: Record<string, unknown>) {
      return relationships.save(admin.id, admin.sessionId, relationshipInput.parse({ version: (await relationships.snapshot()).version, ...data }));
    }
    const family = await save({ kind: "families", displayName: "Workflow family", code: `F-${randomUUID().slice(0,8)}` });
    const student = await save({ kind: "students", displayName: "Workflow student" });
    expect(await db.select().from(user).where(eq(user.id, student.id))).toHaveLength(0);
    const code = `C-${randomUUID().slice(0,8)}`;
    const schoolClass = await save({ kind: "classes", displayName: "Workflow class", code });
    await save({ kind: "family-member", groupId: family.id, personId: guardian.id, relationship: "guardian" });
    await save({ kind: "family-member", groupId: family.id, personId: student.id, relationship: "child" });
    const enrollment = await save({ kind: "class-member", groupId: schoolClass.id, personId: student.id, relationship: "student" });
    const site = await registeredSite(`https://${randomUUID()}.example`), directory = createDirectory(db, config);
    expect((await directory.getAccessContext(guardian.id, site.clientIds[0]!))?.classScopes.parent).toContain(code);
    const graph = await directory.getDirectoryContext(guardian.id, site.clientIds[0]!);
    expect(graph?.directory.people.some(p => p.id === student.id)).toBe(true);
    expect(graph?.directory.people.some(p => p.id === admin.id)).toBe(false);
    expect(graph?.directory.familyMemberships.every(m => m.familyId === family.id)).toBe(true);
    expect(graph?.directory.classes.map(c => c.code)).toEqual([code]);

    await expect(save({ kind: "family-member", groupId: family.id, personId: student.id, relationship: "father" })).rejects.toThrow("relationship");
    await expect(save({ kind: "class-member", groupId: schoolClass.id, personId: student.id, relationship: "student" })).rejects.toThrow("overlapping");
    await expect(save({ kind: "class-member", groupId: schoolClass.id, personId: guardian.id, relationship: "teacher" })).rejects.toThrow("relationship");
    const stale = (await relationships.snapshot()).version;
    await save({ kind: "students", id: student.id, displayName: "Renamed student" });
    await expect(relationships.save(admin.id, admin.sessionId, relationshipInput.parse({ kind: "families", displayName: "Stale", code: "stale", version: stale }))).rejects.toThrow("changed");
    await save({ kind: "class-member", id: enrollment.id, groupId: schoolClass.id, personId: student.id, relationship: "student", status: "inactive" });
    expect((await directory.getAccessContext(guardian.id, site.clientIds[0]!))?.classScopes.parent).not.toContain(code);
    expect((await relationships.snapshot()).classLinks.find(l => l.id === enrollment.id)?.status).toBe("inactive");
    const teacher = await fixture("parent");
    await db.insert(personRoles).values({ personId: teacher.id, role: "teacher" });
    await save({ kind: "class-member", groupId: schoolClass.id, personId: teacher.id, relationship: "teacher" });
    expect((await directory.getAccessContext(teacher.id, site.clientIds[0]!))?.classScopes.teacher).toContain(code);
    await save({ kind: "classes", id: schoolClass.id, displayName: "Workflow class", code, status: "disabled" });
    expect((await directory.getAccessContext(teacher.id, site.clientIds[0]!))?.classScopes.teacher).not.toContain(code);
    expect((await request("/admin/families", guardian.cookie)).status).toBe(303);
    expect((await request(`/admin/families?id=${family.id}`, admin.cookie)).headers.get("location")).toBe(`/admin/families/${family.id}`);
    const page = await request(`/admin/families/${family.id}`, admin.cookie);
    const familyHtml = await page.text();
    expect(familyHtml).toContain("Renamed student");
    const classHtml = await (await request(`/admin/classes/${schoolClass.id}`, admin.cookie)).text();
    expect(classHtml).toContain("Membership history");
    expect(classHtml).toContain("This class is disabled");
    const invalid = new URLSearchParams({ kind: "class-member", groupId: schoolClass.id, personId: student.id, relationship: "student", version: (await relationships.snapshot()).version, startsOn: "2026-10-01", endsOn: "2026-09-01" });
    expect((await request("/admin/directory/save", admin.cookie, invalid)).status).toBe(400);
    const form = new URLSearchParams({ kind: "students", displayName: "Form student", version: (await relationships.snapshot()).version });
    const created = await request("/admin/directory/save", admin.cookie, form);
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toMatch(/^\/admin\/students\/[0-9a-f-]{36}\?saved=1$/);
    // Search-to-add from the family page lists eligible people and excludes current members.
    const search = await request(`/admin/families/${family.id}?add=${encodeURIComponent("Form student")}`, admin.cookie);
    const searchHtml = await search.text();
    expect(searchHtml).toContain("Add as child");
    expect(searchHtml).toContain("Form student");
    const [guardianRow] = await db.select().from(people).where(eq(people.id, guardian.id));
    const member = await (await request(`/admin/families/${family.id}?add=${encodeURIComponent(guardianRow!.normalizedLoginEmail!)}`, admin.cookie)).text();
    expect(member).toContain("No active person matches");
    expect(member).not.toContain("Add as child");
  });
  it("adds members in bulk, ends memberships, moves students between classes and creates linked students", async () => {
    const relationships = relationshipService(db, config), directory = createDirectory(db, config);
    const version = async () => (await relationships.snapshot()).version;
    const post = (data: Record<string, string | string[]>) => {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
      return request("/admin/directory/save", admin.cookie, body);
    };
    const classA = randomUUID(), classB = randomUUID(), familyId = randomUUID();
    await db.insert(classes).values([{ id: classA, code: `A-${classA.slice(0, 8)}`, displayName: "Bulk class A" }, { id: classB, code: `B-${classB.slice(0, 8)}`, displayName: "Bulk class B" }]);
    await db.insert(families).values({ id: familyId, code: `F-${familyId.slice(0, 8)}`, displayName: "Bulk family" });
    const s1 = randomUUID(), s2 = randomUUID();
    await db.insert(people).values([{ id: s1, kind: "student", displayName: "Bulk one" }, { id: s2, kind: "student", displayName: "Bulk two" }]);
    const teacher = await fixture("parent");
    await db.insert(personRoles).values({ personId: teacher.id, role: "teacher" });
    // Bulk enroll two students and a teacher; relationships are inferred from kind/role.
    const enrolled = await post({ kind: "class-member", groupId: classA, personIds: [s1, s2, teacher.id], version: await version(), returnTo: `/admin/classes/${classA}` });
    expect(enrolled.status).toBe(303);
    expect(enrolled.headers.get("location")).toBe(`/admin/classes/${classA}?saved=1`);
    const links = await db.select().from(classMemberships).where(eq(classMemberships.classId, classA));
    expect(links.map(l => l.relationship).sort()).toEqual(["student", "student", "teacher"]);
    // A conflicting person in a batch rolls back the whole batch.
    const conflict = await post({ kind: "class-member", groupId: classA, personIds: [s1, parent.id], version: await version(), returnTo: `/admin/classes/${classA}` });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("overlapping");
    expect(await db.select().from(classMemberships).where(eq(classMemberships.classId, classA))).toHaveLength(3);
    // Move one student to class B: the old enrollment becomes inactive and a new one starts.
    const membership = links.find(l => l.personId === s1)!;
    const moved = await post({ kind: "class-transfer", groupId: classB, membershipIds: membership.id, version: await version(), returnTo: `/admin/classes/${classA}` });
    expect(moved.status).toBe(303);
    expect((await db.select().from(classMemberships).where(eq(classMemberships.id, membership.id)))[0]!.status).toBe("inactive");
    expect((await db.select().from(classMemberships).where(eq(classMemberships.classId, classB)))[0]).toMatchObject({ personId: s1, relationship: "student", status: "active" });
    expect((await directory.getAccessContext(teacher.id, (await registeredSite(`https://${randomUUID()}.example`)).clientIds[0]!))?.classScopes.teacher).toContain(`A-${classA.slice(0, 8)}`);
    // Ending memberships in bulk; already inactive ones are skipped without error.
    const remaining = await db.select().from(classMemberships).where(eq(classMemberships.classId, classA));
    const ended = await post({ kind: "end-memberships", membershipIds: [...remaining.map(l => l.id), membership.id], version: await version(), returnTo: `/admin/classes/${classA}` });
    expect(ended.status).toBe(303);
    expect((await db.select().from(classMemberships).where(eq(classMemberships.classId, classA))).every(l => l.status === "inactive")).toBe(true);
    // Creating a student from the family page links them as a child in the same transaction.
    const newbornName = `Bulk newborn ${randomUUID().slice(0, 8)}`;
    const child = await post({ kind: "students", displayName: newbornName, groupId: familyId, version: await version(), returnTo: `/admin/families/${familyId}` });
    expect(child.status).toBe(303);
    expect(child.headers.get("location")).toBe(`/admin/families/${familyId}?saved=1`);
    const [newborn] = await db.select().from(people).where(eq(people.displayName, newbornName));
    expect((await db.select().from(familyMemberships).where(eq(familyMemberships.personId, newborn!.id)))[0]).toMatchObject({ familyId, relationship: "child" });
    // Adults joining a family need an explicit relationship; the page re-renders with the error.
    const missing = await post({ kind: "family-member", groupId: familyId, personIds: teacher.id, version: await version(), returnTo: `/admin/families/${familyId}` });
    expect(missing.status).toBe(400);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain("Choose father, mother or guardian");
    expect(missingHtml).toContain(newbornName);
    // Pre-approving a parent from a family page returns to that family with the new account pre-searched.
    const email = `${randomUUID()}@example.test`;
    const back = await request("/admin/users", admin.cookie, new URLSearchParams({ displayName: "Bulk parent", email, status: "active", roles: "parent", version: "", returnTo: `/admin/families/${familyId}` }));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`/admin/families/${familyId}?created=1&add=${encodeURIComponent(email)}`);
    const familyPage = await request(back.headers.get("location")!, admin.cookie);
    const familyHtml = await familyPage.text();
    expect(familyHtml).toContain("Adult account created");
    expect(familyHtml).toContain("Bulk parent");
    expect(familyHtml).toContain('name="relationship"');
    // Invalid returnTo values are ignored rather than followed.
    const external = await post({ kind: "students", displayName: "Bulk redirect", version: await version(), returnTo: "https://evil.example/" });
    expect(external.headers.get("location")).toMatch(/^\/admin\/students\/[0-9a-f-]{36}\?saved=1$/);
  });
  it("creates a family atomically through all six wizard steps and ignores repeated confirmation", async () => {
    const classId = randomUUID();
    await db.insert(classes).values({ id: classId, code: `W-${classId}`, displayName: "Wizard class" });
    const studentName = `Wizard student ${randomUUID()}`;
    let response = await request("/admin/families/wizard", admin.cookie);
    let html = await response.text();
    const token = () => html.match(/name="draft" value="([^"]+)"/)![1]!;
    async function next(values: Record<string,string>) {
      response = await request("/admin/families/wizard", admin.cookie, new URLSearchParams({ draft: token(), action: "next", ...values }));
      html = await response.text();
      expect(response.status).toBe(200);
    }
    const initialToken = token();
    expect((await request("/admin/families/wizard", parent.cookie, new URLSearchParams({ draft: initialToken, action: "next" }))).status).toBe(303);
    expect((await request("/admin/families/wizard", admin.cookie, new URLSearchParams({ draft: initialToken + "x", action: "confirm" }))).status).toBe(400);
    await next({ student: studentName });
    await next({ classId });
    expect(html).toContain("&#39;s Family");
    await next({ familyId: "", familyName: `${studentName}'s Family` });
    await next({ action: "add", adultName: "Wizard guardian", adultEmail: `${randomUUID()}@example.test`, relationship: "guardian" });
    await next({});
    expect(html).toContain('role="img"');
    expect(html).toContain("Wizard guardian");
    await next({});
    expect(html).toContain("Confirm creation");
    expect(await db.select().from(people).where(eq(people.displayName, studentName))).toHaveLength(0);
    const finalToken = token();
    const confirm = () => request("/admin/families/wizard", admin.cookie, new URLSearchParams({ draft: finalToken, action: "confirm" }));
    const created = await confirm();
    expect(created.status).toBe(303);
    const familyId = new URL(created.headers.get("location")!, origin).pathname.split("/").pop()!;
    const [student] = await db.select().from(people).where(eq(people.displayName, studentName));
    expect(student!.kind).toBe("student");
    expect(await db.select().from(user).where(eq(user.id, student!.id))).toHaveLength(0);
    expect(await db.select().from(classMemberships).where(eq(classMemberships.personId, student!.id))).toHaveLength(1);
    expect(await db.select().from(familyMemberships).where(eq(familyMemberships.familyId, familyId))).toHaveLength(2);
    expect((await confirm()).headers.get("location")).toBe(created.headers.get("location"));
    expect(await db.select().from(people).where(eq(people.displayName, studentName))).toHaveLength(1);
  });
  it("reuses an existing family and rolls back creation if a selected class becomes disabled", async () => {
    const { familyWizard } = await import("../../src/admin/family-wizard.js");
    const wizard = familyWizard(db, config);
    const classId = randomUUID(), familyId = randomUUID(), adult = await fixture("parent");
    await db.insert(classes).values({ id: classId, code: `W-${classId}`, displayName: "Existing class" });
    await db.insert(families).values({ id: familyId, code: `W-${familyId}`, displayName: "Existing family" });
    await db.insert(familyMemberships).values({ id: randomUUID(), familyId, personId: adult.id, relationship: "guardian" });
    const { relationshipSnapshot } = await import("../../src/admin/relationships.js");
    const snapshot = await relationshipSnapshot(db);
    const chosen = wizard.advance({ ...wizard.start(admin.id), step: 3, student: "New sibling", classId }, { familyId }, snapshot);
    expect(chosen.step).toBe(5);
    expect(chosen.adults).toEqual([]);
    expect(wizard.advance(chosen, { action: "back" }, snapshot).step).toBe(3);
    const d = wizard.advance(chosen, { action: "next" }, snapshot);
    expect(await wizard.create(d, admin.sessionId)).toBe(familyId);
    expect(await db.select().from(familyMemberships).where(eq(familyMemberships.familyId, familyId))).toHaveLength(2);
    await db.update(classes).set({ status: "disabled" }).where(eq(classes.id, classId));
    const blocked = { ...wizard.start(admin.id), step: 6, student: "Blocked sibling", classId, familyName: "Blocked family", adults: [{ id: adult.id, name: "", email: "", relationship: "guardian" as const }] };
    await expect(wizard.create(blocked, admin.sessionId)).rejects.toThrow("no longer active");
    expect(await db.select().from(people).where(eq(people.id, blocked.id))).toHaveLength(0);
    expect(await db.select().from(families).where(eq(families.displayName, "Blocked family"))).toHaveLength(0);
  });
  it("rechecks revocation even with a valid signed session cookie", async () => {
    await db.delete(personRoles).where(eq(personRoles.personId, admin.id));
    expect((await request("/admin", admin.cookie)).status).toBe(403);
    await expect(service.save(admin.id, admin.sessionId, undefined, input())).rejects.toThrow("no longer active");
  });
});
