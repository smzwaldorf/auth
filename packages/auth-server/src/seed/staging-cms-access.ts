import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import { appAccess, applications, auditEvents, people, personRoles, user } from "../db/schema.js";
import { approvedStagingIdentities } from "./staging-identities.js";
export const stagingCmsMigration = "staging.cms-access.2026-09-13";

export async function grantStagingCmsAccess(db: Database) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(1397578323)`);
    if ((await tx.select().from(auditEvents).where(eq(auditEvents.eventType, stagingCmsMigration))).length) return;
    for (const clientId of ["email-cms", "email-cms-server"]) {
      const [app] = await tx.select().from(applications).where(eq(applications.clientId, clientId));
      if (!app?.enabled) throw new Error(`CMS application is not enabled: ${clientId}`);
    }
    for (const { email, role } of approvedStagingIdentities) {
      const [person] = await tx.select().from(people).where(eq(people.normalizedLoginEmail, email));
      const [identity] = await tx.select().from(user).where(eq(user.email, email));
      if (!person || person.kind !== "adult" || person.status !== "active" || identity?.id !== person.id) throw new Error(`Inspect identity mapping for ${email}`);
      const roles = (await tx.select().from(personRoles).where(eq(personRoles.personId, person.id))).map(r => r.role);
      if (!roles.includes(role) || (role === "parent" && roles.includes("admin"))) throw new Error(`Unexpected role for ${email}`);
      // The confidential client intentionally reuses the email-cms admission.
      await tx.insert(appAccess).values({ personId: person.id, clientId: "email-cms", status: "active" })
        .onConflictDoUpdate({ target: [appAccess.personId, appAccess.clientId], set: { status: "active", updatedAt: new Date() } });
    }
    await tx.insert(auditEvents).values({ eventType: stagingCmsMigration, actor: "github-actions:user-approved-cms-access", detail: { emails: approvedStagingIdentities.map(p => p.email), clientId: "email-cms" } });
  });
}
