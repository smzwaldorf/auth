import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { loginInvitations, people, personRoles, user } from "./db/schema.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { normalizeEmail } from "./seed/model.js";

export async function loginAllowed(db: Database, config: RuntimeConfig, userId: string): Promise<boolean> {
  const [row] = await db.select({ email: user.email, personEmail: people.normalizedLoginEmail, invitationEmail: loginInvitations.normalizedEmail })
    .from(user).innerJoin(people, sql`${people.id}::text = ${user.id}`)
    .innerJoin(loginInvitations, eq(loginInvitations.personId, people.id))
    .where(and(eq(user.id, userId), eq(people.kind, "adult"), eq(people.status, "active"),
      inArray(loginInvitations.status, ["pending", "activated"]),
      or(isNull(loginInvitations.expiresAt), gt(loginInvitations.expiresAt, new Date())))).limit(1);
  if (!row || normalizeEmail(row.email) !== row.personEmail || row.personEmail !== row.invitationEmail) return false;
  if (config.STAGING_ADMIN_EMAIL || config.STAGING_PARENT_EMAIL) {
    const email = normalizeEmail(row.email);
    const roles = await db.select({ role: personRoles.role }).from(personRoles).where(sql`${personRoles.personId}::text = ${userId}`);
    if (email === config.STAGING_ADMIN_EMAIL) return roles.some(r => r.role === "admin");
    if (email === config.STAGING_PARENT_EMAIL) return roles.some(r => r.role === "parent") && !roles.some(r => r.role === "admin");
    return false;
  }
  return true;
}
