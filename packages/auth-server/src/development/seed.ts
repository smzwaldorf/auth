import { and, eq, or } from "drizzle-orm";
import type { RuntimeConfig as AuthConfig } from "../runtime-config.js";
type AuthSettings = { trustedClientIds: Set<string> };
import type { Database } from "../db/database.js";
import { account, applications, classMemberships, classes, loginInvitations, oauthClient, people, personRoles, user } from "../db/schema.js";
/** First class of the local newsletter demo fixture (scripts/seed-demo.mjs); the development teacher teaches it when present. */
const demoClassId = "de900000-0000-4000-8000-000000000201";
const demoTeacherMembershipId = "d4100000-0000-4000-8000-000000000011";
import { developmentIdentities, developmentLoginEnabled } from "./policy.js";

/** Insert fixed synthetic identities only. Never update existing identities or restore revoked access. */
export function createDevelopmentSeeder(db: Database, config: AuthConfig, { trustedClientIds }: AuthSettings) {
return async function seedDevelopmentIdentities() {
  if (!developmentLoginEnabled(config)) throw new Error("Development login requires explicit opt-in, development mode, a loopback issuer/database, and a matching _dev or _test database name");
  await db.transaction(async (tx) => {
    const clients = await tx.select({ id: applications.clientId }).from(applications)
      .innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId))
      .where(and(eq(applications.enabled, true), eq(oauthClient.disabled, false)));
    const clientIds = clients.map((client) => client.id).filter((id) => trustedClientIds.has(id));
    if (!clientIds.includes("email-cms")) throw new Error("Enable and register the local email-cms client before provisioning development identities");
    for (const identity of Object.values(developmentIdentities)) {
      const existingPeople = await tx.select().from(people).where(or(eq(people.id, identity.id), eq(people.normalizedLoginEmail, identity.email)));
      const existingUsers = await tx.select().from(user).where(or(eq(user.id, identity.id), eq(user.email, identity.email)));
      const invitations = await tx.select().from(loginInvitations).where(or(eq(loginInvitations.id, identity.invitationId), eq(loginInvitations.personId, identity.id), eq(loginInvitations.normalizedEmail, identity.email)));
      if (existingPeople.length || existingUsers.length || invitations.length) {
        const person = existingPeople[0], authUser = existingUsers[0], invitation = invitations[0];
        const roles = await tx.select().from(personRoles).where(eq(personRoles.personId, identity.id));
        const links = await tx.select().from(account).where(eq(account.userId, identity.id));
        if (existingPeople.length !== 1 || existingUsers.length !== 1 || invitations.length !== 1 ||
            person?.id !== identity.id || person.normalizedLoginEmail !== identity.email || person.kind !== "adult" || person.status !== "active" ||
            authUser?.id !== identity.id || authUser.email !== identity.email || !authUser.emailVerified ||
            invitation?.id !== identity.invitationId || invitation.personId !== identity.id || invitation.normalizedEmail !== identity.email || invitation.status !== "activated" ||
            roles.length !== 1 || roles[0]?.role !== identity.role || links.length) {
          throw new Error(`Reserved development identity collision or changed approval: ${identity.role}; no records changed`);
        }
        continue;
      }
      await tx.insert(people).values({ id: identity.id, kind: "adult", displayName: identity.name, normalizedLoginEmail: identity.email, status: "active" });
      await tx.insert(user).values({ id: identity.id, name: identity.name, email: identity.email, emailVerified: true });
      await tx.insert(personRoles).values({ personId: identity.id, role: identity.role });
      await tx.insert(loginInvitations).values({ id: identity.invitationId, personId: identity.id, normalizedEmail: identity.email, status: "activated", activatedAt: new Date() });
    }
    // Give the development teacher one class when the demo fixture exists so teacher flows have data. Insert-only: never
    // recreated if an administrator has ended it, and skipped if an equivalent active assignment already exists.
    const [demoClass] = await tx.select({ id: classes.id }).from(classes).where(and(eq(classes.id, demoClassId), eq(classes.status, "active")));
    const teacherLinks = demoClass ? await tx.select({ id: classMemberships.id }).from(classMemberships).where(and(eq(classMemberships.classId, demoClassId), eq(classMemberships.personId, developmentIdentities.schoolTeacher.id))) : [];
    if (demoClass && !teacherLinks.length) await tx.insert(classMemberships).values({ id: demoTeacherMembershipId, classId: demoClassId, personId: developmentIdentities.schoolTeacher.id, relationship: "teacher" });
  });
}
}
