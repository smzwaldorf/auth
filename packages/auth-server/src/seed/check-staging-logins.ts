import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { people, user, personRoles, loginInvitations, appAccess } from "../db/schema.js";
import { loginAllowed } from "../login-policy.js";

// Read-only release gate: report only the configured operator-confirmed identities.
try {
  let valid = true;
  const requested = [["admin", config.STAGING_ADMIN_EMAIL] as const, ...[config.STAGING_PARENT_EMAIL, ...config.STAGING_PARENT_EMAILS].filter(Boolean).map(email => ["parent", email] as const)];
  for (const [role, email] of requested) {
    const matches = await db.select().from(people).where(eq(people.normalizedLoginEmail, email!));
    const [person] = matches;
    const [identity] = await db.select({ id: user.id, email: user.email }).from(user).where(sql`lower(${user.email}) = ${email}`);
    const roles = person ? await db.select({ role: personRoles.role }).from(personRoles).where(eq(personRoles.personId, person.id)) : [];
    const invitations = person ? await db.select({ email: loginInvitations.normalizedEmail, status: loginInvitations.status, expiresAt: loginInvitations.expiresAt }).from(loginInvitations).where(eq(loginInvitations.personId, person.id)) : [];
    const grants = person ? await db.select({ clientId: appAccess.clientId, status: appAccess.status }).from(appAccess).where(eq(appAccess.personId, person.id)) : [];
    const allowed = Boolean(person && identity?.id === person.id && await loginAllowed(db, config, person.id));
    console.log(JSON.stringify({ requestedRole: role, email, person: person ? { id: person.id, kind: person.kind, status: person.status } : null, identityId: identity?.id ?? null, roles, invitations, grants, allowed }));
    valid &&= allowed;
  }
  if (!valid) throw new Error("Staging account preflight failed; no directory records were changed. Resolve the reported mapping before deployment.");
} finally { await closeDatabase(); }
