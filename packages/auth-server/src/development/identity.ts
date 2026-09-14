import { eq } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { account, loginInvitations, people, personRoles, user } from "../db/schema.js";
import { developmentIdentities, developmentLoginEnabled } from "./policy.js";

export async function validDevelopmentIdentity(db: Database, config: RuntimeConfig, id: string): Promise<boolean> {
  if (!developmentLoginEnabled(config)) return false;
  const identity = Object.values(developmentIdentities).find(value => value.id === id);
  if (!identity) return false;
  const [[person], [authUser], [invitation], roles, links] = await Promise.all([
    db.select().from(people).where(eq(people.id, id)),
    db.select().from(user).where(eq(user.id, id)),
    db.select().from(loginInvitations).where(eq(loginInvitations.personId, id)),
    db.select().from(personRoles).where(eq(personRoles.personId, id)),
    db.select({ id: account.id }).from(account).where(eq(account.userId, id)),
  ]);
  return person?.kind === "adult" && person.status === "active" && person.normalizedLoginEmail === identity.email &&
    authUser?.email === identity.email && authUser.emailVerified &&
    invitation?.id === identity.invitationId && invitation.normalizedEmail === identity.email && invitation.status === "activated" &&
    (!invitation.expiresAt || invitation.expiresAt > new Date()) && roles.length === 1 && roles[0]?.role === identity.role && links.length === 0;
}
