import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, families, classes, familyMemberships, classMemberships, personRoles, session, auditEvents } from "../db/schema.js";
import { isAdmin } from "./service.js";
import { AdminError } from "./model.js";
import { isDevelopmentIdentity } from "../development/policy.js";
const optionalId = z.union([z.uuid(), z.literal("")]).default("");
const date = z.union([z.iso.date(), z.literal("")]).default("");
export const relationshipInput = z.object({
  kind: z.enum(["families", "students", "classes", "family-member", "class-member"]),
  id: optionalId, version: z.string().length(64), displayName: z.string().trim().max(120).default(""),
  code: z.string().trim().max(40).default(""), status: z.enum(["active", "disabled", "inactive"]).default("active"),
  groupId: optionalId, personId: optionalId,
  relationship: z.enum(["father", "mother", "guardian", "child", "student", "teacher"]).optional(),
  startsOn: date, endsOn: date,
}).superRefine((v, c) => {
  if (v.startsOn && v.endsOn && v.startsOn > v.endsOn) c.addIssue({ code: "custom", message: "End date must be on or after start date." });
  if (["families", "students", "classes"].includes(v.kind)) {
    if (!v.displayName || v.status === "inactive") c.addIssue({ code: "custom", message: "Enter a name and an active or disabled status." });
    if (v.kind !== "students" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(v.code)) c.addIssue({ code: "custom", message: "Enter a code using letters, numbers, underscores or hyphens." });
  } else if (!v.groupId || !v.personId || !v.relationship || v.status === "disabled") c.addIssue({ code: "custom", message: "Choose a person, relationship and active or inactive status." });
});
type Connection = Pick<Database, "select">;
export async function relationshipSnapshot(db: Connection) {
  // Transaction connections execute these reads sequentially.
  const persons = await db.select().from(people).orderBy(people.id);
  const familyRows = await db.select().from(families).orderBy(families.id);
  const classRows = await db.select().from(classes).orderBy(classes.id);
  const familyLinks = await db.select().from(familyMemberships).orderBy(familyMemberships.id);
  const classLinks = await db.select().from(classMemberships).orderBy(classMemberships.id);
  const roles = await db.select().from(personRoles).orderBy(personRoles.personId, personRoles.role);
  const data = { persons, families: familyRows, classes: classRows, familyLinks, classLinks, roles };
  return { ...data, version: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
}
export function relationshipService(db: Database, config: RuntimeConfig) {
  async function save(actorId: string, sessionId: string, raw: z.infer<typeof relationshipInput>) {
    const input = relationshipInput.parse(raw);
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [live] = await tx.select().from(session).where(and(eq(session.id, sessionId), eq(session.userId, actorId), sql`${session.expiresAt} > now()`));
      if (!live || !(await isAdmin(tx, config, actorId))) throw new AdminError("Administrator access is no longer active.", 403);
      const data = await relationshipSnapshot(tx);
      if (data.version !== input.version) throw new AdminError("Directory records changed. Reload and review before saving.", 409);
      const id = input.id || randomUUID(), now = new Date();
      let before: unknown = null;
      if (["families", "classes"].includes(input.kind)) {
        const table = input.kind === "families" ? families : classes;
        const rows = input.kind === "families" ? data.families : data.classes;
        const previous = rows.find(r => r.id === id); before = previous;
        if (input.id && !previous) throw new AdminError("Record not found.", 404);
        if (previous && previous.code !== input.code) throw new AdminError("Codes are fixed to preserve links with consuming applications.");
        if (rows.some(r => r.code === input.code && r.id !== id)) throw new AdminError("That code is already in use.", 409);
        const values = { displayName: input.displayName, code: input.code, status: input.status as "active" | "disabled", updatedAt: now };
        if (previous) await tx.update(table).set(values).where(eq(table.id, id));
        else await tx.insert(table).values({ id, ...values });
      } else if (input.kind === "students") {
        const previous = data.persons.find(r => r.id === id); before = previous;
        if (input.id && (!previous || previous.kind !== "student")) throw new AdminError("Student not found.", 404);
        const values = { displayName: input.displayName, status: input.status as "active" | "disabled", updatedAt: now };
        if (previous) await tx.update(people).set(values).where(eq(people.id, id));
        else {
          await tx.insert(people).values({ id, kind: "student", ...values });
          await tx.insert(personRoles).values({ personId: id, role: "student" });
        }
      } else {
        const family = input.kind === "family-member";
        const group = (family ? data.families : data.classes).find(r => r.id === input.groupId);
        const person = data.persons.find(r => r.id === input.personId);
        if (!group || !person) throw new AdminError("Choose an existing group and person.");
        if (isDevelopmentIdentity(person.id)) throw new AdminError("Development identities are managed by their seeder.", 403);
        const validRole = family ? person.kind === "student" ? input.relationship === "child" : ["father", "mother", "guardian"].includes(input.relationship!) : person.kind === "student" ? input.relationship === "student" : input.relationship === "teacher" && data.roles.some(r => r.personId === person.id && r.role === "teacher");
        if (!validRole) throw new AdminError("The relationship does not match the person's kind or school role.");
        if (input.status === "active" && (group.status !== "active" || person.status !== "active")) throw new AdminError("Activate the person and group before assigning membership.");
        const links = family ? data.familyLinks.map(r => ({ ...r, groupId: r.familyId })) : data.classLinks.map(r => ({ ...r, groupId: r.classId }));
        const previous = links.find(r => r.id === id); before = previous;
        if (input.id && (!previous || previous.groupId !== input.groupId || previous.personId !== input.personId || previous.relationship !== input.relationship)) throw new AdminError("Membership identity cannot be changed. End the old membership and add a new one.");
        if (input.status === "active" && links.some(r => r.id !== id && r.groupId === input.groupId && r.personId === input.personId && r.status === "active" && (!r.endsOn || !input.startsOn || r.endsOn >= input.startsOn) && (!input.endsOn || !r.startsOn || input.endsOn >= r.startsOn))) throw new AdminError("This person already has an overlapping membership in this group.", 409);
        const values = { status: input.status as "active" | "inactive", startsOn: input.startsOn || null, endsOn: input.endsOn || null, updatedAt: now };
        if (family) {
          if (previous) await tx.update(familyMemberships).set(values).where(eq(familyMemberships.id, id));
          else await tx.insert(familyMemberships).values({ id, familyId: input.groupId, personId: input.personId, relationship: input.relationship as "child" | "father" | "mother" | "guardian", ...values });
        } else {
          if (previous) await tx.update(classMemberships).set(values).where(eq(classMemberships.id, id));
          else await tx.insert(classMemberships).values({ id, classId: input.groupId, personId: input.personId, relationship: input.relationship as "student" | "teacher", ...values });
        }
      }
      await tx.insert(auditEvents).values({ eventType: `admin.directory.${input.kind}.${input.id ? "updated" : "created"}`, actor: actorId, detail: { id, before: before ?? null, after: { ...input, version: undefined } } });
      return { id, section: input.kind === "family-member" ? "families" : input.kind === "class-member" ? "classes" : input.kind };
    });
  }
  return { snapshot: () => relationshipSnapshot(db), save };
}
