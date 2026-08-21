import { eq } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  account,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  people,
  personRoles,
  session,
  user,
} from "./db/schema.js";

export const manageableRoles = ["admin", "teacher", "parent", "student"] as const;
export type ManageableRole = (typeof manageableRoles)[number];

export type AdminPerson = {
  id: string;
  kind: "adult" | "student";
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  roles: ManageableRole[];
};

function isValidRoles(kind: AdminPerson["kind"], roles: readonly string[]): roles is ManageableRole[] {
  if (!roles.length || !roles.every((role) => (manageableRoles as readonly string[]).includes(role))) return false;
  if (kind === "student") return roles.length === 1 && roles[0] === "student";
  return !roles.includes("student");
}

export async function listPeopleForAdmin(): Promise<AdminPerson[]> {
  const rows = await db
    .select({
      id: people.id,
      kind: people.kind,
      displayName: people.displayName,
      email: people.normalizedLoginEmail,
      status: people.status,
      role: personRoles.role,
    })
    .from(people)
    .leftJoin(personRoles, eq(personRoles.personId, people.id));
  const result = new Map<string, AdminPerson>();
  for (const row of rows) {
    const current = result.get(row.id) ?? {
      id: row.id,
      kind: row.kind,
      displayName: row.displayName,
      email: row.email,
      status: row.status,
      roles: [],
    };
    if (row.role) current.roles.push(row.role);
    result.set(row.id, current);
  }
  return [...result.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function updatePersonFromAdmin(input: {
  personId: string;
  displayName: string;
  status: "active" | "disabled";
  roles: string[];
}): Promise<AdminPerson | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: people.id, kind: people.kind, email: people.normalizedLoginEmail })
      .from(people)
      .where(eq(people.id, input.personId))
      .limit(1);
    if (!existing || !isValidRoles(existing.kind, input.roles)) return null;

    await tx
      .update(people)
      .set({ displayName: input.displayName, status: input.status, updatedAt: now })
      .where(eq(people.id, existing.id));
    await tx.delete(personRoles).where(eq(personRoles.personId, existing.id));
    await tx.insert(personRoles).values(input.roles.map((role) => ({ personId: existing.id, role })));

    if (existing.kind === "adult") {
      await tx.update(user).set({ name: input.displayName, updatedAt: now }).where(eq(user.id, existing.id));
    }
    if (input.status === "disabled") {
      await tx.delete(session).where(eq(session.userId, existing.id));
      await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, existing.id));
      await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, existing.id));
      await tx.delete(oauthConsent).where(eq(oauthConsent.userId, existing.id));
      await tx.delete(account).where(eq(account.userId, existing.id));
    }
    return {
      id: existing.id,
      kind: existing.kind,
      displayName: input.displayName,
      email: existing.email,
      status: input.status,
      roles: input.roles,
    };
  });
}
