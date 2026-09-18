import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";

import { serve } from "@hono/node-server";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth-factory.js";
import { config as baseConfig } from "../../src/config.js";
import { closeDatabase, db } from "../../src/db/client.js";
import {
  applications,
  classMemberships,
  classes,
  families,
  familyMemberships,
  loginInvitations,
  people,
  personRoles,
  session,
  user,
} from "../../src/db/schema.js";
import { runtimeUrls } from "../../src/runtime-config.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
import { validateDirectorySeed } from "../../src/seed/model.js";

const enabled = process.env.RUN_DB_TESTS === "true";
const cmsOrigin = "http://localhost:5174";
let config = { ...baseConfig, CMS_ORIGIN: cmsOrigin, STAGING_ADMIN_EMAIL: "", STAGING_PARENT_EMAIL: "" };
let authOrigin: string;
let directoryAudience: string;
let app: ReturnType<typeof createApp>;
let auth: ReturnType<typeof createAuth>;
let server: ReturnType<typeof serve> | undefined;
let nodeOrigin: string;
let setupComplete = false;
const serverSecret = "synthetic-cms-server-secret-at-least-32-characters";
process.env.CMS_OIDC_CLIENT_SECRET = serverSecret;

const school = { code: "directory-api-test-school", displayName: "Directory API test school" };
const resourceSeed = validateDirectorySeed({ version: 1, school, people: [], families: [], classes: [], appAccess: [], applications: [] });
const cms = validateDirectorySeed({
  version: 1,
  school,
  people: [],
  families: [],
  classes: [],
  appAccess: [],
  applications: [
    {
      clientId: "email-cms",
      displayName: "Email CMS",
      clientType: "public",
      publicOrigin: config.CMS_ORIGIN,
      redirectUris: [`${config.CMS_ORIGIN}/auth/callback`],
      postLogoutRedirectUris: [`${config.CMS_ORIGIN}/login`],
      frontChannelLogoutUri: `${config.CMS_ORIGIN}/logout/local`,
      scopes: ["openid", "profile", "email", "directory:access", "offline_access"],
    },
    {
      clientId: "email-cms-server",
      displayName: "Email CMS server",
      clientType: "confidential",
      clientSecretEnv: "CMS_OIDC_CLIENT_SECRET",
      publicOrigin: config.CMS_ORIGIN,
      redirectUris: [`${config.CMS_ORIGIN}/api/session/callback`],
      postLogoutRedirectUris: [`${config.CMS_ORIGIN}/login`],
      frontChannelLogoutUri: `${config.CMS_ORIGIN}/logout/local`,
      scopes: ["openid", "profile", "email", "directory:access", "offline_access"],
    },
  ],
});

type FixtureIds = {
  admin: string;
  parent: string;
  teacher: string;
  otherParent: string;
  adultNoEmail: string;
  studentOwn: string;
  studentOther: string;
  studentHidden: string;
  studentFuture: string;
  studentInactive: string;
  familyParent: string;
  familyOther: string;
  classOne: string;
  classTwo: string;
  people: string[];
  families: string[];
  classes: string[];
};

type IssuedToken = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  sessionId: string;
  clientId: string;
};

type DirectoryResponse = {
  roles: string[];
  clientId: string;
  directory: {
    people: Array<{ id: string; displayName: string; kind: string; normalizedLoginEmail?: string }>;
    families: Array<{ id: string; code: string; displayName: string }>;
    classes: Array<{ id: string; code: string; displayName: string }>;
    familyMemberships: Array<{ familyId: string; personId: string; relationship: string }>;
    classMemberships: Array<{ classId: string; personId: string; relationship: string }>;
  };
};

type DeliveryContactResponse = {
  contractVersion: number;
  fetchedAt: string;
  contacts: Array<{
    personId: string;
    displayName: string;
    email: string;
    families: Array<{
      familyId: string;
      familyCode: string;
      relationships: string[];
      classIds: string[];
      classCodes: string[];
    }>;
  }>;
};

const fixtureIds: FixtureIds = {
  admin: randomUUID(),
  parent: randomUUID(),
  teacher: randomUUID(),
  otherParent: randomUUID(),
  adultNoEmail: randomUUID(),
  studentOwn: randomUUID(),
  studentOther: randomUUID(),
  studentHidden: randomUUID(),
  studentFuture: randomUUID(),
  studentInactive: randomUUID(),
  familyParent: randomUUID(),
  familyOther: randomUUID(),
  classOne: randomUUID(),
  classTwo: randomUUID(),
  people: [],
  families: [],
  classes: [],
};
fixtureIds.people = [
  fixtureIds.admin,
  fixtureIds.parent,
  fixtureIds.teacher,
  fixtureIds.otherParent,
  fixtureIds.adultNoEmail,
  fixtureIds.studentOwn,
  fixtureIds.studentOther,
  fixtureIds.studentHidden,
  fixtureIds.studentFuture,
  fixtureIds.studentInactive,
];
fixtureIds.families = [fixtureIds.familyParent, fixtureIds.familyOther];
fixtureIds.classes = [fixtureIds.classOne, fixtureIds.classTwo];

function requireDisposableTestDatabase(): void {
  const url = new URL(config.DATABASE_URL);
  if (!process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/smz_magic_test_\d+$/.test(url.pathname)) {
    throw new Error("Directory API integration tests require an explicitly selected disposable local smz_magic_test_<n> database");
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      probe.removeListener("error", onError);
      reject(error);
    };
    probe.once("error", onError);
    probe.listen(0, "127.0.0.1", () => {
      probe.removeListener("error", onError);
      resolve();
    });
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    throw new Error("Unable to reserve an isolated loopback port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startAuthServer(port: number): Promise<ReturnType<typeof serve>> {
  return new Promise((resolve, reject) => {
    let instance: ReturnType<typeof serve> | undefined;
    const onError = (error: Error) => {
      if (instance) instance.removeListener("error", onError);
      reject(error);
    };
    try {
      instance = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
        if (!instance) return reject(new Error("Auth listener started without a server instance"));
        instance.removeListener("error", onError);
        resolve(instance);
      });
      instance.once("error", onError);
    } catch (error) {
      reject(error);
    }
  });
}

function emailFor(personId: string): string {
  return `${personId}@directory-api.example.test`;
}

async function insertFixture(): Promise<void> {
  const adults = [
    [fixtureIds.admin, "admin"],
    [fixtureIds.parent, "parent"],
    [fixtureIds.teacher, "teacher"],
    [fixtureIds.otherParent, "parent"],
  ] as const;
  await db.insert(people).values([
    ...adults.map(([id, role]) => ({ id, kind: "adult" as const, displayName: `Fixture ${role}`, normalizedLoginEmail: emailFor(id) })),
    { id: fixtureIds.studentOwn, kind: "student", displayName: "Fixture Own Student" },
    { id: fixtureIds.studentOther, kind: "student", displayName: "Fixture Other Student" },
    { id: fixtureIds.studentHidden, kind: "student", displayName: "Fixture Hidden Student" },
    { id: fixtureIds.studentFuture, kind: "student", displayName: "Fixture Future Student" },
    { id: fixtureIds.studentInactive, kind: "student", displayName: "Fixture Inactive Student" },
    { id: fixtureIds.adultNoEmail, kind: "adult", displayName: "Fixture Adult Without Email" },
  ]);
  await db.insert(user).values(adults.map(([id, role]) => ({ id, name: `Fixture ${role}`, email: emailFor(id), emailVerified: true })));
  await db.insert(personRoles).values(adults.map(([id, role]) => ({ personId: id, role: role as "admin" | "parent" | "teacher" })));
  await db.insert(loginInvitations).values(adults.map(([id]) => ({ id: randomUUID(), personId: id, normalizedEmail: emailFor(id), status: "activated" as const })));
  await db.insert(families).values([
    { id: fixtureIds.familyParent, code: "fixture-parent-family", displayName: "Fixture Parent Family" },
    { id: fixtureIds.familyOther, code: "fixture-other-family", displayName: "Fixture Other Family" },
  ]);
  await db.insert(familyMemberships).values([
    { id: randomUUID(), familyId: fixtureIds.familyParent, personId: fixtureIds.parent, relationship: "guardian" as const },
    { id: randomUUID(), familyId: fixtureIds.familyParent, personId: fixtureIds.adultNoEmail, relationship: "guardian" as const },
    { id: randomUUID(), familyId: fixtureIds.familyParent, personId: fixtureIds.studentOwn, relationship: "child" as const },
    { id: randomUUID(), familyId: fixtureIds.familyParent, personId: fixtureIds.studentInactive, relationship: "child" as const, status: "inactive" as const },
    { id: randomUUID(), familyId: fixtureIds.familyOther, personId: fixtureIds.otherParent, relationship: "father" as const, startsOn: "2099-01-01" },
    { id: randomUUID(), familyId: fixtureIds.familyOther, personId: fixtureIds.studentOther, relationship: "child" as const },
  ]);
  await db.insert(classes).values([
    { id: fixtureIds.classOne, code: "FIXTURE-G1", displayName: "Fixture Grade 1" },
    { id: fixtureIds.classTwo, code: "FIXTURE-G2", displayName: "Fixture Grade 2" },
  ]);
  await db.insert(classMemberships).values([
    { id: randomUUID(), classId: fixtureIds.classOne, personId: fixtureIds.studentOwn, relationship: "student" as const },
    { id: randomUUID(), classId: fixtureIds.classOne, personId: fixtureIds.studentOther, relationship: "student" as const },
    { id: randomUUID(), classId: fixtureIds.classOne, personId: fixtureIds.teacher, relationship: "teacher" as const },
    { id: randomUUID(), classId: fixtureIds.classOne, personId: fixtureIds.studentFuture, relationship: "student" as const, startsOn: "2099-01-01" },
    { id: randomUUID(), classId: fixtureIds.classTwo, personId: fixtureIds.studentHidden, relationship: "student" as const },
    { id: randomUUID(), classId: fixtureIds.classTwo, personId: fixtureIds.teacher, relationship: "teacher" as const, endsOn: "2000-01-01" },
  ]);
}

async function centralSession(personId: string): Promise<{ id: string; cookie: string }> {
  const current = await (await auth.$context).internalAdapter.createSession(personId);
  if (!current) throw new Error("Expected a central session");
  const signature = createHmac("sha256", config.BETTER_AUTH_SECRET).update(current.token).digest("base64");
  return { id: current.id, cookie: `better-auth.session_token=${encodeURIComponent(`${current.token}.${signature}`)}` };
}

function redirectUri(clientId: string): string {
  return clientId === "email-cms-server" ? `${config.CMS_ORIGIN}/api/session/callback` : `${config.CMS_ORIGIN}/auth/callback`;
}

async function issue(personId: string, clientId = "email-cms", scope = "openid profile email offline_access directory:access"): Promise<IssuedToken> {
  const current = await centralSession(personId);
  const verifier = "fixture-directory-verifier-012345678901234567890123456789";
  const redirect = redirectUri(clientId);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    resource: directoryAudience,
    state: randomUUID(),
    nonce: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorize = await auth.handler(new Request(`${config.AUTH_ISSUER}/oauth2/authorize?${query}`, { headers: { cookie: current.cookie } }));
  expect(authorize.status, await authorize.clone().text()).toBe(302);
  const callback = new URL(authorize.headers.get("location")!, authOrigin);
  expect(callback.origin + callback.pathname).toBe(redirect);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirect,
    code: callback.searchParams.get("code")!,
    code_verifier: verifier,
    resource: directoryAudience,
  });
  if (clientId === "email-cms-server") body.set("client_secret", serverSecret);
  const response = await auth.handler(new Request(`${config.AUTH_ISSUER}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
  expect(response.status, await response.clone().text()).toBe(200);
  return { ...await response.json() as Omit<IssuedToken, "sessionId" | "clientId">, sessionId: current.id, clientId };
}

async function directory(token: string): Promise<Response> {
  return fetch(`${nodeOrigin}/api/directory/v1/me/directory`, { headers: { authorization: `Bearer ${token}` } });
}

async function deliveryContacts(token: string): Promise<Response> {
  return fetch(`${nodeOrigin}/api/directory/v1/me/delivery-contacts`, { headers: { authorization: `Bearer ${token}` } });
}

async function readDirectory(token: string): Promise<DirectoryResponse> {
  const response = await directory(token);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as DirectoryResponse;
}

describe.runIf(enabled).sequential("directory API contract", () => {
  beforeAll(async () => {
    requireDisposableTestDatabase();
    const port = await reserveLoopbackPort();
    config = { ...config, AUTH_ISSUER: `http://127.0.0.1:${port}/api/auth` };
    ({ authOrigin, directoryAudience } = runtimeUrls(config));
    app = createApp(config, db);
    auth = createAuth(config, db);
    nodeOrigin = authOrigin;
    server = await startAuthServer(port);
    await applyDirectorySeed(resourceSeed, config);
    await applyDirectorySeed(cms, config);
    await insertFixture();
    setupComplete = true;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (!setupComplete) {
      await closeDatabase();
      return;
    }
    await db.delete(user).where(inArray(user.id, fixtureIds.people));
    await db.delete(people).where(inArray(people.id, fixtureIds.people));
    await db.delete(families).where(inArray(families.id, fixtureIds.families));
    await db.delete(classes).where(inArray(classes.id, fixtureIds.classes));
    await closeDatabase();
  });

  it("enforces admin, parent, and teacher scopes while excluding inactive, future, and ended relationships", async () => {
    const admin = await readDirectory((await issue(fixtureIds.admin)).access_token);
    const parent = await readDirectory((await issue(fixtureIds.parent)).access_token);
    const teacher = await readDirectory((await issue(fixtureIds.teacher)).access_token);

    expect(admin.roles).toEqual(["admin"]);
    expect(admin.directory.families.map((family) => family.code)).toEqual(expect.arrayContaining(["fixture-other-family", "fixture-parent-family"]));
    expect(admin.directory.classes.map((schoolClass) => schoolClass.code)).toEqual(expect.arrayContaining(["FIXTURE-G1", "FIXTURE-G2"]));
    expect(admin.directory.familyMemberships).toEqual(expect.arrayContaining([
      { familyId: fixtureIds.familyParent, personId: fixtureIds.parent, relationship: "guardian" },
      { familyId: fixtureIds.familyParent, personId: fixtureIds.studentOwn, relationship: "child" },
      { familyId: fixtureIds.familyOther, personId: fixtureIds.studentOther, relationship: "child" },
    ]));
    expect(admin.directory.familyMemberships).not.toEqual(expect.arrayContaining([{ familyId: fixtureIds.familyParent, personId: fixtureIds.studentInactive, relationship: "child" }]));
    expect(admin.directory.familyMemberships).not.toEqual(expect.arrayContaining([{ familyId: fixtureIds.familyOther, personId: fixtureIds.otherParent, relationship: "father" }]));
    expect(admin.directory.classMemberships).toEqual(expect.arrayContaining([
      { classId: fixtureIds.classOne, personId: fixtureIds.studentOwn, relationship: "student" },
      { classId: fixtureIds.classOne, personId: fixtureIds.studentOther, relationship: "student" },
      { classId: fixtureIds.classTwo, personId: fixtureIds.studentHidden, relationship: "student" },
    ]));
    expect(admin.directory.classMemberships).not.toEqual(expect.arrayContaining([{ classId: fixtureIds.classOne, personId: fixtureIds.studentFuture, relationship: "student" }]));
    expect(admin.directory.classMemberships).not.toEqual(expect.arrayContaining([{ classId: fixtureIds.classTwo, personId: fixtureIds.teacher, relationship: "teacher" }]));
    expect(admin.directory.people.every((person) => !("normalizedLoginEmail" in person))).toBe(true);

    expect(parent.roles).toEqual(["parent"]);
    expect(parent.directory.families.map((family) => family.code)).toEqual(["fixture-parent-family"]);
    expect(parent.directory.classes.map((schoolClass) => schoolClass.code)).toEqual(["FIXTURE-G1"]);
    expect(parent.directory.familyMemberships.every((membership) => membership.familyId === fixtureIds.familyParent)).toBe(true);
    expect(parent.directory.familyMemberships.some((membership) => membership.personId === fixtureIds.studentInactive)).toBe(false);
    expect(parent.directory.classMemberships).toEqual(expect.arrayContaining([
      { classId: fixtureIds.classOne, personId: fixtureIds.studentOwn, relationship: "student" },
      { classId: fixtureIds.classOne, personId: fixtureIds.teacher, relationship: "teacher" },
    ]));
    expect(parent.directory.classMemberships.some((membership) => membership.personId === fixtureIds.studentOther)).toBe(false);
    expect(parent.directory.families.some((family) => family.id === fixtureIds.familyOther)).toBe(false);

    expect(teacher.roles).toEqual(["teacher"]);
    expect(teacher.directory.families.map((family) => family.code)).toEqual(expect.arrayContaining(["fixture-other-family", "fixture-parent-family"]));
    expect(teacher.directory.classes.map((schoolClass) => schoolClass.code)).toEqual(["FIXTURE-G1"]);
    expect(teacher.directory.classMemberships).toEqual(expect.arrayContaining([
      { classId: fixtureIds.classOne, personId: fixtureIds.studentOwn, relationship: "student" },
      { classId: fixtureIds.classOne, personId: fixtureIds.studentOther, relationship: "student" },
      { classId: fixtureIds.classOne, personId: fixtureIds.teacher, relationship: "teacher" },
    ]));
    expect(teacher.directory.classMemberships.some((membership) => membership.classId === fixtureIds.classTwo)).toBe(false);
    expect(teacher.directory.familyMemberships.some((membership) => membership.personId === fixtureIds.otherParent)).toBe(false);
  });

  it("requires the directory scope and expected audience for bearer API access, for both CMS clients", async () => {
    const browserToken = await issue(fixtureIds.admin, "email-cms");
    expect((await directory(browserToken.access_token)).status).toBe(200);
    const serverToken = await issue(fixtureIds.admin, "email-cms-server");
    expect((await directory(serverToken.access_token)).status).toBe(200);

    const narrowToken = await issue(fixtureIds.admin, "email-cms", "openid profile email offline_access");
    const insufficient = await directory(narrowToken.access_token);
    expect(insufficient.status).toBe(403);
    expect(await insufficient.json()).toMatchObject({ error: "insufficient_scope" });

    expect(browserToken.id_token).toBeTruthy();
    const wrongAudience = await directory(browserToken.id_token!);
    expect(wrongAudience.status).toBe(401);
    expect(await wrongAudience.json()).toMatchObject({ error: "invalid_access_token" });
  });

  it("returns canonical active guardian contacts only to the confidential CMS admin client", async () => {
    const serverToken = await issue(fixtureIds.admin, "email-cms-server");
    const response = await deliveryContacts(serverToken.access_token);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as DeliveryContactResponse;
    expect(body.contractVersion).toBe(1);
    expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false);
    const parent = body.contacts.find(contact => contact.personId === fixtureIds.parent);
    expect(parent).toMatchObject({
      personId: fixtureIds.parent,
      email: emailFor(fixtureIds.parent),
      families: [{
        familyId: fixtureIds.familyParent,
        familyCode: "fixture-parent-family",
        relationships: ["guardian"],
        classIds: [fixtureIds.classOne],
        classCodes: ["FIXTURE-G1"],
      }],
    });
    expect(body.contacts.some(contact => contact.personId === fixtureIds.adultNoEmail)).toBe(false);
    expect(body.contacts.some(contact => contact.personId === fixtureIds.studentOwn)).toBe(false);
    expect(body.contacts.some(contact => contact.personId === fixtureIds.otherParent)).toBe(false);

    const browserToken = await issue(fixtureIds.admin, "email-cms");
    const browserResponse = await deliveryContacts(browserToken.access_token);
    expect(browserResponse.status).toBe(403);
    expect(await browserResponse.json()).toMatchObject({ error: "delivery_access_denied" });

    const parentToken = await issue(fixtureIds.parent, "email-cms-server");
    const parentResponse = await deliveryContacts(parentToken.access_token);
    expect(parentResponse.status).toBe(403);
    expect(await parentResponse.json()).toMatchObject({ error: "delivery_access_denied" });

    const narrowToken = await issue(fixtureIds.admin, "email-cms-server", "openid profile email offline_access");
    const insufficient = await deliveryContacts(narrowToken.access_token);
    expect(insufficient.status).toBe(403);
    expect(await insufficient.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("rechecks central session and application admission after token issuance", async () => {
    const sessionToken = await issue(fixtureIds.parent);
    expect((await directory(sessionToken.access_token)).status).toBe(200);
    await db.delete(session).where(eq(session.id, sessionToken.sessionId));
    const revokedSession = await directory(sessionToken.access_token);
    expect(revokedSession.status).toBe(403);
    expect(await revokedSession.json()).toMatchObject({ error: "access_revoked" });

    const appToken = await issue(fixtureIds.parent);
    expect((await directory(appToken.access_token)).status).toBe(200);
    await db.update(applications).set({ enabled: false }).where(eq(applications.clientId, "email-cms"));
    try {
      const revokedApplication = await directory(appToken.access_token);
      expect(revokedApplication.status).toBe(403);
      expect(await revokedApplication.json()).toMatchObject({ error: "access_revoked" });
    } finally {
      await db.update(applications).set({ enabled: true }).where(eq(applications.clientId, "email-cms"));
    }
  });
});
