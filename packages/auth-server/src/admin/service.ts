import { siteCatalog } from "./sites.js";
import { and, eq, ilike, or, sql, inArray } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, personRoles, oauthClient, user, loginInvitations, applications, appAccess, auditEvents, session, oauthAccessToken, oauthRefreshToken, familyMemberships, classMemberships, families, classes } from "../db/schema.js";
import { loginAllowed } from "../login-policy.js";
import { isDevelopmentIdentity } from "../development/policy.js";
import { validDevelopmentIdentity } from "../development/identity.js";
import { AdminError, protectSelf, type UserInput } from "./model.js";
import { t } from "./i18n.js";

type Connection = Pick<Database, "select">;
export async function isAdmin(db: Connection, config: RuntimeConfig, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [person] = await db.select({ id: people.id }).from(people)
    .innerJoin(personRoles, and(eq(personRoles.personId, people.id), eq(personRoles.role, "admin")))
    .where(and(eq(people.id, id), eq(people.kind, "adult"), eq(people.status, "active"))).limit(1);
  // Both policy helpers only select; keep the transaction's reads on its connection.
  return Boolean(person) && (isDevelopmentIdentity(id)
    ? validDevelopmentIdentity(db as Database, config, id)
    : loginAllowed(db as Database, config, id));
}
export function adminService(db: Database, config: RuntimeConfig) {
  async function forceSignOut(actorId: string, actorSessionId: string, targetId: string) {
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [live] = await tx.select().from(session).where(and(eq(session.id, actorSessionId), eq(session.userId, actorId), sql`${session.expiresAt} > now()`));
      if (!live || !(await isAdmin(tx, config, actorId))) throw new AdminError(t("Administrator access is no longer active."), 403);
      const [target] = await tx.select().from(people).where(eq(people.id, targetId)).for("update");
      if (!target) throw new AdminError(t("User not found."), 404);
      if (target.kind !== "adult" || !target.normalizedLoginEmail) throw new AdminError(t("Only adult login accounts have sign-in sessions."));
      await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, targetId));
      await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, targetId));
      await tx.delete(session).where(eq(session.userId, targetId));
      await tx.insert(auditEvents).values({ eventType: "admin.user.signed_out", actor: actorId, personId: targetId });
    });
  }

  async function list(query: string, page: number, status: string, role = "", kind = "") {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const condition = and(query ? or(ilike(people.displayName, pattern), ilike(people.normalizedLoginEmail, pattern)) : undefined,
      status === "active" || status === "disabled" ? eq(people.status, status) : undefined,
      kind === "adult" || kind === "student" ? eq(people.kind, kind) : undefined,
      ["admin", "teacher", "parent", "student"].includes(role) ? sql`exists (select 1 from ${personRoles} where ${personRoles.personId} = ${people.id} and ${personRoles.role} = ${role})` : undefined);
    const [rows, [total]] = await Promise.all([
      db.select().from(people).where(condition).orderBy(people.displayName, people.id).limit(25).offset((page - 1) * 25),
      db.select({ count: sql<number>`count(*)::int` }).from(people).where(condition),
    ]);
    const ids = rows.map(r => r.id);
    const [roles, familyRows, classRows, invitations] = ids.length ? await Promise.all([
      db.select().from(personRoles).where(inArray(personRoles.personId, ids)),
      db.select({ personId: familyMemberships.personId, groupId: families.id, name: families.displayName, relationship: familyMemberships.relationship, status: familyMemberships.status, startsOn: familyMemberships.startsOn, endsOn: familyMemberships.endsOn })
        .from(familyMemberships).innerJoin(families, eq(families.id, familyMemberships.familyId)).where(inArray(familyMemberships.personId, ids)),
      db.select({ personId: classMemberships.personId, groupId: classes.id, name: classes.displayName, relationship: classMemberships.relationship, status: classMemberships.status, startsOn: classMemberships.startsOn, endsOn: classMemberships.endsOn })
        .from(classMemberships).innerJoin(classes, eq(classes.id, classMemberships.classId)).where(inArray(classMemberships.personId, ids)),
      db.select({ personId: loginInvitations.personId, status: loginInvitations.status }).from(loginInvitations).where(inArray(loginInvitations.personId, ids)),
    ]) : [[], [], [], []];
    const day = new Date().toISOString().slice(0, 10);
    const live = (m: { status: string; startsOn: string | null; endsOn: string | null }) => m.status === "active" && (!m.startsOn || m.startsOn <= day) && (!m.endsOn || m.endsOn >= day);
    return {
      rows: rows.map(r => ({
        ...r,
        roles: roles.filter(role => role.personId === r.id).map(role => role.role),
        families: familyRows.filter(m => m.personId === r.id && live(m)).map(m => ({ id: m.groupId, name: m.name, relationship: m.relationship })).sort((a, b) => a.name.localeCompare(b.name)),
        classes: classRows.filter(m => m.personId === r.id && live(m)).map(m => ({ id: m.groupId, name: m.name, relationship: m.relationship })).sort((a, b) => a.name.localeCompare(b.name)),
        invitation: invitations.find(i => i.personId === r.id)?.status ?? null,
      })),
      total: total?.count ?? 0,
    };
  }
  async function overview() {
    const [[pending], [apps]] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(loginInvitations).innerJoin(people, eq(people.id, loginInvitations.personId)).where(and(eq(loginInvitations.status, "pending"), eq(people.status, "active"))),
      db.select({ count: sql<number>`count(*)::int` }).from(applications).innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId)).where(and(eq(applications.enabled, true), eq(oauthClient.disabled, false))),
    ]);
    return { pendingInvitations: pending?.count ?? 0, applications: apps?.count ?? 0 };
  }
  async function detail(id: string) {
    const [[person], roles, grants, [invitation]] = await Promise.all([
      db.select().from(people).where(eq(people.id, id)),
      db.select().from(personRoles).where(eq(personRoles.personId, id)),
      db.select().from(appAccess).where(eq(appAccess.personId, id)),
      db.select().from(loginInvitations).where(eq(loginInvitations.personId, id)),
    ]);
    return person ? { ...person, roles: roles.map(r => r.role), clients: grants.filter(g => g.status === "active").map(g => g.clientId), invitation } : null;
  }
  async function save(actorId: string, actorSessionId: string, id: string | undefined, input: UserInput) {
    const targetId = id ?? crypto.randomUUID();
    protectSelf(actorId, targetId, input);
    if (isDevelopmentIdentity(targetId)) throw new AdminError(t("Synthetic development accounts are managed by the development seeder."), 403);
    await db.transaction(async tx => {
      // Serialize admin writes so concurrent demotions cannot remove both acting admins.
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [liveSession] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, actorSessionId), eq(session.userId, actorId), sql`${session.expiresAt} > now()`));
      if (!liveSession || !(await isAdmin(tx, config, actorId))) throw new AdminError(t("Administrator access is no longer active."), 403);
      const [existing] = await tx.select().from(people).where(eq(people.id, targetId)).for("update");
      if (id && !existing) throw new AdminError(t("User not found."), 404);
      if (existing && (existing.kind !== "adult" || !existing.normalizedLoginEmail)) throw new AdminError(t("Only adult login accounts can be edited here."));
      if (existing && existing.updatedAt.toISOString() !== input.version) throw new AdminError(t("This user changed since you opened the form. Reload and review the latest details."), 409);
      if (existing && input.email !== existing.normalizedLoginEmail) throw new AdminError(t("Login emails cannot be reassigned through this panel."));
      if (input.sites.length) throw new AdminError(t("Application access is automatic. Reload this user form before saving."), 409);
      const now = new Date();
      if (!existing) {
        await tx.insert(people).values({ id: targetId, kind: "adult", displayName: input.displayName, normalizedLoginEmail: input.email, status: input.status });
        await tx.insert(user).values({ id: targetId, name: input.displayName, email: input.email, emailVerified: false });
        await tx.insert(loginInvitations).values({ id: crypto.randomUUID(), personId: targetId, normalizedEmail: input.email, status: "pending" });
      } else {
        await tx.update(people).set({ displayName: input.displayName, status: input.status, updatedAt: now }).where(eq(people.id, targetId));
        await tx.update(user).set({ name: input.displayName, updatedAt: now }).where(eq(user.id, targetId));
        const [invitation] = await tx.select().from(loginInvitations).where(eq(loginInvitations.personId, targetId));
        if (!invitation) throw new AdminError(t("This account has no login approval. Repair its directory record before editing."));
        await tx.update(loginInvitations).set({ status: invitation.status === "activated" ? "activated" : "pending", expiresAt: null, updatedAt: now }).where(eq(loginInvitations.personId, targetId));
      }
      await tx.delete(personRoles).where(eq(personRoles.personId, targetId));
      await tx.insert(personRoles).values(input.roles.map(role => ({ personId: targetId, role })));
      // Revoke all tokens before sessions (FK deletion can null out session references).
      if (existing && actorId !== targetId) {
        await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, targetId));
        await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, targetId));
        await tx.delete(session).where(eq(session.userId, targetId));
      }
      await tx.insert(auditEvents).values({ eventType: existing ? "admin.user.updated" : "admin.user.created", actor: actorId, personId: targetId,
        detail: { status: input.status, roles: input.roles, sites: input.sites } });
    });
    return targetId;
  }
  return { list, detail, save, forceSignOut, overview, apps: async () => siteCatalog(await db.select({ clientId: applications.clientId, displayName: applications.displayName, publicOrigin: applications.publicOrigin, enabled: applications.enabled, oauthDisabled: oauthClient.disabled }).from(applications).innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId))) };
}
