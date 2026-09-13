import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import { people, user, personRoles, loginInvitations, appAccess, applications, auditEvents } from "../db/schema.js";

export const stagingIdentityMigration = "staging.magic-link-identities.2026-09-13";
export const approvedStagingIdentities = [
  { email: "smzwaldorf.education@gmail.com", role: "admin" },
  { email: "buildwithharry@gmail.com", role: "parent" },
] as const;

// One-time additive migration, based on the read-only live inventory from
// Actions 34748115465. Never reseed roles, renew invitations, or restore grants.
export async function addStagingIdentities(db: Database) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(1397578323)`);
    if ((await tx.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.eventType, stagingIdentityMigration))).length) return;
    for (const { email } of approvedStagingIdentities) {
      const existingPeople = await tx.select({ id: people.id }).from(people).where(sql`lower(${people.normalizedLoginEmail}) = ${email}`);
      const existingUsers = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`);
      const existingInvitations = await tx.select({ id: loginInvitations.id }).from(loginInvitations).where(sql`lower(${loginInvitations.normalizedEmail}) = ${email}`);
      if (existingPeople.length || existingUsers.length || existingInvitations.length) throw new Error(`Account inventory changed for ${email}; inspect before applying this migration`);
    }
    for (const clientId of ["vite-app", "express-app"]) {
      const [app] = await tx.select().from(applications).where(eq(applications.clientId, clientId));
      if (!app?.enabled) throw new Error(`Expected enabled staging application: ${clientId}`);
    }
    for (const { email, role } of approvedStagingIdentities) {
      const id = randomUUID();
      await tx.insert(people).values({ id, kind: "adult", displayName: email, normalizedLoginEmail: email, status: "active" });
      await tx.insert(user).values({ id, name: email, email, emailVerified: false });
      await tx.insert(personRoles).values({ personId: id, role });
      await tx.insert(loginInvitations).values({ id: randomUUID(), personId: id, normalizedEmail: email, status: "pending" });
      await tx.insert(appAccess).values(["vite-app", "express-app"].map(clientId => ({ personId: id, clientId, status: "active" as const })));
    }
    await tx.insert(auditEvents).values({ eventType: stagingIdentityMigration, actor: "github-actions:approved-staging-migration", detail: { identities: approvedStagingIdentities, clients: ["vite-app", "express-app"] } });
  });
}
