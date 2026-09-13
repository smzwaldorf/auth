import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../src/config.js";
import { db, closeDatabase } from "../../src/db/client.js";
import { people, user, personRoles, loginInvitations, appAccess, auditEvents } from "../../src/db/schema.js";
import { addStagingIdentities, approvedStagingIdentities, stagingIdentityMigration } from "../../src/seed/staging-identities.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
import { validateDirectorySeed } from "../../src/seed/model.js";
import { loginAllowed } from "../../src/login-policy.js";
import { grantStagingCmsAccess, stagingCmsMigration } from "../../src/seed/staging-cms-access.js";
import { createDirectory } from "../../src/directory/service.js";
const emails = approvedStagingIdentities.map(p => p.email);
const selectedConfig = { ...config, STAGING_ADMIN_EMAIL: emails[0]!, STAGING_PARENT_EMAIL: emails[1]! };
async function cleanup() {
  await db.delete(auditEvents).where(eq(auditEvents.eventType, stagingCmsMigration));
  await db.delete(people).where(inArray(people.normalizedLoginEmail, emails));
  await db.delete(user).where(inArray(user.email, emails));
  await db.delete(auditEvents).where(eq(auditEvents.eventType, stagingIdentityMigration));
}
describe.runIf(process.env.RUN_DB_TESTS === "true").sequential("approved staging identity migration", () => {
  beforeAll(async () => {
    const url = new URL(config.DATABASE_URL);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/(smz_identity|smz_magic_test_\d+)$/.test(url.pathname)) throw new Error("Disposable local test database required");
    const seed = JSON.parse(fs.readFileSync(path.resolve("seeds/directory.seed.example.json"), "utf8"));
    seed.applications.push(...["email-cms", "email-cms-server"].map(clientId => ({ ...seed.applications[0], clientId })));
    await applyDirectorySeed(validateDirectorySeed(seed));
  });
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await closeDatabase(); });
  it("adds exactly the confirmed roles and demo grants, preserving other people", async () => {
    const before = await db.select().from(people);
    await addStagingIdentities(db);
    expect(await db.select().from(people)).toHaveLength(before.length + 2);
    for (const expected of approvedStagingIdentities) {
      const [person] = await db.select().from(people).where(eq(people.normalizedLoginEmail, expected.email));
      expect(await loginAllowed(db, selectedConfig, person!.id)).toBe(true);
      expect((await db.select().from(personRoles).where(eq(personRoles.personId, person!.id))).map(r => r.role)).toEqual([expected.role]);
      expect((await db.select().from(appAccess).where(eq(appAccess.personId, person!.id))).map(a => a.clientId).sort()).toEqual(["express-app", "vite-app"]);
      if (expected.role === "parent") {
        await db.insert(personRoles).values({ personId: person!.id, role: "admin" });
        expect(await loginAllowed(db, selectedConfig, person!.id)).toBe(false);
      }
    }
  });
  it("grants both CMS clients without changing roles and preserves later revocation", async () => {
    await addStagingIdentities(db);
    await grantStagingCmsAccess(db);
    for (const { email, role } of approvedStagingIdentities) {
      const [person] = await db.select().from(people).where(eq(people.normalizedLoginEmail, email));
      const directory = createDirectory(db, selectedConfig);
      expect(await directory.hasLiveAppAccess(person!.id, "email-cms")).toBe(true);
      expect(await directory.hasLiveAppAccess(person!.id, "email-cms-server")).toBe(true);
      expect((await db.select().from(personRoles).where(eq(personRoles.personId, person!.id))).map(r => r.role)).toEqual([role]);
    }
    await db.update(appAccess).set({ status: "revoked" }).where(eq(appAccess.clientId, "email-cms"));
    await grantStagingCmsAccess(db);
    expect((await db.select().from(appAccess).where(eq(appAccess.clientId, "email-cms"))).every(a => a.status === "revoked")).toBe(true);
  });
  it("is idempotent and never restores a revoked invitation", async () => {
    await addStagingIdentities(db);
    await db.update(loginInvitations).set({ status: "revoked" }).where(eq(loginInvitations.normalizedEmail, emails[1]!));
    await addStagingIdentities(db);
    expect((await db.select().from(loginInvitations).where(eq(loginInvitations.normalizedEmail, emails[1]!)))[0]!.status).toBe("revoked");
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, stagingIdentityMigration))).toHaveLength(1);
  });
  it("fails atomically when the inspected inventory has changed", async () => {
    await db.insert(user).values({ id: "staging-conflict-test", email: emails[1]!, name: "Conflict" });
    await expect(addStagingIdentities(db)).rejects.toThrow("inventory changed");
    expect(await db.select().from(people).where(inArray(people.normalizedLoginEmail, emails))).toHaveLength(0);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, stagingIdentityMigration))).toHaveLength(0);
  });
});
