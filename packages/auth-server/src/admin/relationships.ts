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
const idList = z.preprocess(v => v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v], z.array(z.uuid()).max(60));
export const returnPath = /^\/admin(\/[A-Za-z0-9_\-/]*)?$/;
export const relationshipInput = z.object({
  kind: z.enum(["families", "students", "classes", "family-member", "class-member", "end-memberships", "class-transfer"]),
  id: optionalId, version: z.string().length(64), displayName: z.string().trim().max(120).default(""),
  code: z.string().trim().max(40).default(""), status: z.enum(["active", "disabled", "inactive"]).default("active"),
  groupId: optionalId, personId: optionalId, personIds: idList, membershipIds: idList,
  relationship: z.enum(["father", "mother", "guardian", "child", "student", "teacher", ""]).optional().transform(v => v || undefined),
  startsOn: date, endsOn: date,
  returnTo: z.string().max(300).default("").transform(v => returnPath.test(v) ? v : ""),
}).superRefine((v, c) => {
  if (v.startsOn && v.endsOn && v.startsOn > v.endsOn) c.addIssue({ code: "custom", message: "End date must be on or after start date." });
  if (["families", "students", "classes"].includes(v.kind)) {
    if (!v.displayName || v.status === "inactive") c.addIssue({ code: "custom", message: "Enter a name and an active or disabled status." });
    if (v.kind !== "students" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(v.code)) c.addIssue({ code: "custom", message: "Enter a code using letters, numbers, underscores or hyphens." });
  } else if (v.kind === "end-memberships") {
    if (!v.membershipIds.length) c.addIssue({ code: "custom", message: "Select at least one membership to end." });
  } else if (v.kind === "class-transfer") {
    if (!v.groupId || !v.membershipIds.length) c.addIssue({ code: "custom", message: "Choose a destination class and at least one enrollment to move." });
  } else if (!v.groupId || (!v.id && !v.personId && !v.personIds.length) || v.status === "disabled") c.addIssue({ code: "custom", message: "Choose at least one person and an active or inactive status." });
});
export type RelationshipInput = z.infer<typeof relationshipInput>;
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
export type Snapshot = Awaited<ReturnType<typeof relationshipSnapshot>>;
export type Person = Snapshot["persons"][number];
export type Group = Snapshot["families"][number];
export type FamilyLink = Snapshot["familyLinks"][number];
export type ClassLink = Snapshot["classLinks"][number];
type Dated = { status: string; startsOn: string | null; endsOn: string | null };
export type MembershipState = "active" | "scheduled" | "ended" | "inactive";
export const today = () => new Date().toISOString().slice(0, 10);
export function membershipState(link: Dated, day = today()): MembershipState {
  if (link.status !== "active") return "inactive";
  if (link.startsOn && link.startsOn > day) return "scheduled";
  if (link.endsOn && link.endsOn < day) return "ended";
  return "active";
}
export const effective = (link: Dated, day = today()) => membershipState(link, day) === "active";
const current = (link: Dated, day = today()) => ["active", "scheduled"].includes(membershipState(link, day));
const byName = <T extends { displayName: string }>(a: T, b: T) => a.displayName.localeCompare(b.displayName);
const matches = (haystack: string, q: string) => !q || haystack.toLowerCase().includes(q.toLowerCase());
export function indexSnapshot(data: Snapshot) {
  const persons = new Map(data.persons.map(p => [p.id, p] as const));
  const familiesById = new Map(data.families.map(f => [f.id, f] as const));
  const classesById = new Map(data.classes.map(c => [c.id, c] as const));
  const roles = new Map<string, string[]>();
  for (const r of data.roles) roles.set(r.personId, [...roles.get(r.personId) ?? [], r.role]);
  return { persons, families: familiesById, classes: classesById, roles, hasRole: (id: string, role: string) => roles.get(id)?.includes(role) ?? false };
}
export type Index = ReturnType<typeof indexSnapshot>;
/** Effective family and class memberships of one person, resolved to group names. */
export function personSummary(data: Snapshot, ix: Index, personId: string) {
  return {
    families: data.familyLinks.filter(l => l.personId === personId && effective(l)).map(l => ({ id: l.familyId, name: ix.families.get(l.familyId)?.displayName ?? "Family", relationship: l.relationship })).sort((a, b) => a.name.localeCompare(b.name)),
    classes: data.classLinks.filter(l => l.personId === personId && effective(l)).map(l => ({ id: l.classId, name: ix.classes.get(l.classId)?.displayName ?? "Class", relationship: l.relationship })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
export type PersonSummary = ReturnType<typeof personSummary>;
const stateOrder: Record<MembershipState, number> = { active: 0, scheduled: 1, ended: 2, inactive: 3 };
/** Everything the person detail pages need to show and manage one person's relationships. */
export function personContext(data: Snapshot, personId: string, query = "") {
  const ix = indexSnapshot(data);
  const person = ix.persons.get(personId);
  const familyLinks = data.familyLinks.filter(l => l.personId === personId).map(l => ({ ...l, group: ix.families.get(l.familyId)!, state: membershipState(l) })).filter(l => l.group)
    .sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || byName(a.group, b.group));
  const classLinks = data.classLinks.filter(l => l.personId === personId).map(l => {
    const others = data.classLinks.filter(m => m.classId === l.classId && m.personId !== personId && effective(m));
    return { ...l, group: ix.classes.get(l.classId)!, state: membershipState(l),
      teachers: others.filter(m => m.relationship === "teacher").map(m => ix.persons.get(m.personId)?.displayName).filter((n): n is string => Boolean(n)).sort(),
      studentCount: others.filter(m => m.relationship === "student").length };
  }).filter(l => l.group).sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || byName(a.group, b.group));
  const currentFamilyIds = new Set(familyLinks.filter(l => current(l)).map(l => l.familyId));
  const currentClassIds = new Set(classLinks.filter(l => current(l)).map(l => l.classId));
  const related = data.familyLinks.filter(l => currentFamilyIds.has(l.familyId) && l.personId !== personId && effective(l))
    .map(l => ({ ...l, person: ix.persons.get(l.personId)!, family: ix.families.get(l.familyId)!, summary: personSummary(data, ix, l.personId) })).filter(l => l.person && l.person.status === "active").sort((a, b) => byName(a.person, b.person));
  const q = query.trim();
  const familyMatches = q ? data.families.filter(f => f.status === "active" && !currentFamilyIds.has(f.id) && matches(`${f.displayName} ${f.code}`, q)).sort(byName).slice(0, 12)
    .map(f => ({ ...f, members: data.familyLinks.filter(l => l.familyId === f.id && effective(l)).map(l => ix.persons.get(l.personId)).filter((p): p is Person => Boolean(p)).map(p => p.displayName) })) : [];
  const classOptions = data.classes.filter(c => c.status === "active" && !currentClassIds.has(c.id)).sort(byName);
  return { version: data.version, person, roles: ix.roles.get(personId) ?? [], isTeacher: ix.hasRole(personId, "teacher"), familyLinks, classLinks, related, familyMatches, classOptions, hasFamilies: data.families.some(f => f.status === "active") };
}
export type PersonContext = ReturnType<typeof personContext>;
/** Everything a family or class detail page needs: current members, history, and add candidates. */
export function groupContext(data: Snapshot, section: "families" | "classes", groupId: string, query = "") {
  const ix = indexSnapshot(data);
  const family = section === "families";
  const group = (family ? ix.families : ix.classes).get(groupId);
  const links = (family ? data.familyLinks.filter(l => l.familyId === groupId) : data.classLinks.filter(l => l.classId === groupId))
    .map(l => ({ ...l, person: ix.persons.get(l.personId)!, state: membershipState(l), summary: personSummary(data, ix, l.personId) })).filter(l => l.person);
  const currentLinks = links.filter(l => current(l)).sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || byName(a.person, b.person));
  const history = links.filter(l => !current(l)).sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0));
  const adults = currentLinks.filter(l => l.person.kind === "adult"), students = currentLinks.filter(l => l.person.kind === "student");
  const currentIds = new Set(currentLinks.map(l => l.personId));
  const eligible = (p: Person) => p.status === "active" && !isDevelopmentIdentity(p.id) && !currentIds.has(p.id) && (family || p.kind === "student" || ix.hasRole(p.id, "teacher"));
  const decorate = (p: Person) => ({ ...p, roles: ix.roles.get(p.id) ?? [], summary: personSummary(data, ix, p.id) });
  const q = query.trim();
  const candidates = q ? data.persons.filter(p => eligible(p) && matches(`${p.displayName} ${p.normalizedLoginEmail ?? ""}`, q)).sort(byName).slice(0, 20).map(decorate) : [];
  const unplacedStudents = !family && !q ? data.persons.filter(p => p.kind === "student" && eligible(p) && !data.classLinks.some(l => l.personId === p.id && current(l))).sort(byName).slice(0, 20).map(decorate) : [];
  const otherClasses = family ? [] : data.classes.filter(c => c.id !== groupId && c.status === "active").sort(byName);
  // Teachers are few, so classes offer the full list of unassigned teachers without searching.
  const availableTeachers = family ? [] : data.persons.filter(p => p.kind === "adult" && ix.hasRole(p.id, "teacher") && eligible(p)).sort(byName).map(decorate);
  return { version: data.version, section, group, adults, students, history, candidates, unplacedStudents, otherClasses, availableTeachers };
}
export type GroupContext = ReturnType<typeof groupContext>;
/** Directory-wide counts and data-hygiene items surfaced on the overview page. */
export function directoryInsights(data: Snapshot) {
  const ix = indexSnapshot(data);
  const activeStudents = data.persons.filter(p => p.kind === "student" && p.status === "active" && !isDevelopmentIdentity(p.id));
  const activeAdults = data.persons.filter(p => p.kind === "adult" && p.status === "active" && !isDevelopmentIdentity(p.id));
  const inClass = new Set(data.classLinks.filter(l => effective(l)).map(l => l.personId));
  const inFamily = new Set(data.familyLinks.filter(l => effective(l)).map(l => l.personId));
  const guarded = new Set(data.familyLinks.filter(l => effective(l) && l.relationship !== "child" && ix.persons.get(l.personId)?.status === "active").map(l => l.familyId));
  const withChildren = new Set(data.familyLinks.filter(l => effective(l) && l.relationship === "child" && ix.persons.get(l.personId)?.status === "active").map(l => l.familyId));
  const taught = new Set(data.classLinks.filter(l => effective(l) && l.relationship === "teacher" && ix.persons.get(l.personId)?.status === "active").map(l => l.classId));
  const activeFamilies = data.families.filter(f => f.status === "active"), activeClasses = data.classes.filter(c => c.status === "active");
  return {
    counts: { adults: activeAdults.length, students: activeStudents.length, families: activeFamilies.length, classes: activeClasses.length },
    attention: {
      studentsWithoutClass: activeStudents.filter(p => !inClass.has(p.id)).sort(byName),
      studentsWithoutFamily: activeStudents.filter(p => !inFamily.has(p.id)).sort(byName),
      familiesWithoutGuardian: activeFamilies.filter(f => !guarded.has(f.id)).sort(byName),
      familiesWithoutChildren: activeFamilies.filter(f => !withChildren.has(f.id)).sort(byName),
      classesWithoutTeacher: activeClasses.filter(c => !taught.has(c.id)).sort(byName),
      parentsWithoutFamily: activeAdults.filter(p => ix.hasRole(p.id, "parent") && !inFamily.has(p.id)).sort(byName),
    },
  };
}
export type Insights = ReturnType<typeof directoryInsights>;
export type ListFilters = { q: string; page: number; classId?: string; familyId?: string; needs?: string; status?: string };
const pageSize = 50;
function paginate<T>(rows: T[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(pages, Math.max(1, page));
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total: rows.length, page: p, pages };
}
export function studentsList(data: Snapshot, f: ListFilters) {
  const ix = indexSnapshot(data);
  const rows = data.persons.filter(p => p.kind === "student").map(p => ({ ...p, summary: personSummary(data, ix, p.id) }))
    .filter(p => matches(p.displayName, f.q) && (!f.status || p.status === f.status)
      && (!f.classId || p.summary.classes.some(c => c.id === f.classId)) && (!f.familyId || p.summary.families.some(x => x.id === f.familyId))
      && (f.needs !== "class" || (p.status === "active" && !p.summary.classes.length)) && (f.needs !== "family" || (p.status === "active" && !p.summary.families.length)))
    .sort(byName);
  return { ...paginate(rows, f.page), classes: [...data.classes].sort(byName), families: [...data.families].sort(byName) };
}
export function familiesList(data: Snapshot, f: ListFilters) {
  const ix = indexSnapshot(data);
  const rows = data.families.map(fam => {
    const members = data.familyLinks.filter(l => l.familyId === fam.id && effective(l)).map(l => ({ ...l, person: ix.persons.get(l.personId)! })).filter(l => l.person && l.person.status === "active");
    return { ...fam, guardians: members.filter(m => m.relationship !== "child").map(m => m.person).sort(byName), children: members.filter(m => m.relationship === "child").map(m => m.person).sort(byName) };
  }).filter(fam => matches(`${fam.displayName} ${fam.code} ${fam.guardians.map(p => p.displayName).join(" ")} ${fam.children.map(p => p.displayName).join(" ")}`, f.q) && (!f.status || fam.status === f.status)
    && (f.needs !== "guardian" || (fam.status === "active" && !fam.guardians.length)) && (f.needs !== "children" || (fam.status === "active" && !fam.children.length))).sort(byName);
  return paginate(rows, f.page);
}
export function classesList(data: Snapshot, f: ListFilters) {
  const ix = indexSnapshot(data);
  const rows = data.classes.map(cls => {
    const members = data.classLinks.filter(l => l.classId === cls.id && effective(l)).map(l => ({ ...l, person: ix.persons.get(l.personId)! })).filter(l => l.person && l.person.status === "active");
    return { ...cls, teachers: members.filter(m => m.relationship === "teacher").map(m => m.person).sort(byName), studentCount: members.filter(m => m.relationship === "student").length };
  }).filter(cls => matches(`${cls.displayName} ${cls.code} ${cls.teachers.map(p => p.displayName).join(" ")}`, f.q) && (!f.status || cls.status === f.status)
    && (f.needs !== "teacher" || (cls.status === "active" && !cls.teachers.length))).sort(byName);
  return paginate(rows, f.page);
}
export function relationshipService(db: Database, config: RuntimeConfig) {
  async function save(actorId: string, sessionId: string, raw: RelationshipInput) {
    const input = relationshipInput.parse(raw);
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      const [live] = await tx.select().from(session).where(and(eq(session.id, sessionId), eq(session.userId, actorId), sql`${session.expiresAt} > now()`));
      if (!live || !(await isAdmin(tx, config, actorId))) throw new AdminError("Administrator access is no longer active.", 403);
      const data = await relationshipSnapshot(tx);
      if (data.version !== input.version) throw new AdminError("Directory records changed. Reload and review before saving.", 409);
      const ix = indexSnapshot(data);
      let id = input.id || randomUUID();
      const now = new Date();
      let before: unknown = null, after: unknown = { ...input, version: undefined };
      let section: "families" | "students" | "classes" = "families";
      /** Page to land on after saving; membership operations return to the group page. */
      let landing = "";
      const membershipValues = (status: "active" | "inactive", startsOn: string, endsOn: string) => ({ status, startsOn: startsOn || null, endsOn: endsOn || null, updatedAt: now });
      /** Validates and inserts one membership; `added` tracks rows created earlier in this same transaction for overlap checks. */
      async function addMembership(family: boolean, groupId: string, personId: string, relationship: RelationshipInput["relationship"], startsOn: string, endsOn: string, added: { groupId: string; personId: string; startsOn: string | null; endsOn: string | null }[]) {
        const group = (family ? ix.families : ix.classes).get(groupId), person = ix.persons.get(personId);
        if (!group || !person) throw new AdminError("Choose an existing group and person.");
        if (isDevelopmentIdentity(person.id)) throw new AdminError("Development identities are managed by their seeder.", 403);
        // Class relationships follow from the person's kind; family relationships need an explicit choice for adults.
        const inferred = family ? (person.kind === "student" ? "child" : relationship) : (person.kind === "student" ? "student" : "teacher");
        if (relationship && relationship !== inferred) throw new AdminError(`${person.displayName}: the relationship does not match the person's kind or school role.`);
        const validRole = family ? (person.kind === "student" ? inferred === "child" : ["father", "mother", "guardian"].includes(inferred ?? "")) : (person.kind === "student" || ix.hasRole(person.id, "teacher"));
        if (!validRole || !inferred) throw new AdminError(family && person.kind === "adult" && !relationship ? `Choose father, mother or guardian for ${person.displayName}.` : `${person.displayName}: the relationship does not match the person's kind or school role.`);
        if (group.status !== "active" || person.status !== "active") throw new AdminError("Activate the person and group before assigning membership.");
        const links = family ? data.familyLinks.map(r => ({ ...r, groupId: r.familyId })) : data.classLinks.map(r => ({ ...r, groupId: r.classId }));
        const overlap = (r: { groupId: string; personId: string; startsOn: string | null; endsOn: string | null; status?: string }) => r.groupId === groupId && r.personId === personId && (r.status ?? "active") === "active" && (!r.endsOn || !startsOn || r.endsOn >= startsOn) && (!endsOn || !r.startsOn || endsOn >= r.startsOn);
        if (links.some(overlap) || added.some(overlap)) throw new AdminError(`${person.displayName} already has an overlapping membership in ${group.displayName}.`, 409);
        const membershipId = randomUUID(), values = membershipValues("active", startsOn, endsOn);
        if (family) await tx.insert(familyMemberships).values({ id: membershipId, familyId: groupId, personId, relationship: inferred as "child" | "father" | "mother" | "guardian", ...values });
        else await tx.insert(classMemberships).values({ id: membershipId, classId: groupId, personId, relationship: inferred as "student" | "teacher", ...values });
        added.push({ groupId, personId, startsOn: startsOn || null, endsOn: endsOn || null });
        return membershipId;
      }
      if (input.kind === "families" || input.kind === "classes") {
        section = input.kind;
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
        section = "students";
        const previous = data.persons.find(r => r.id === id); before = previous;
        if (input.id && (!previous || previous.kind !== "student")) throw new AdminError("Student not found.", 404);
        const values = { displayName: input.displayName, status: input.status as "active" | "disabled", updatedAt: now };
        if (previous) await tx.update(people).set(values).where(eq(people.id, id));
        else {
          await tx.insert(people).values({ id, kind: "student", ...values });
          await tx.insert(personRoles).values({ personId: id, role: "student" });
          if (input.groupId) {
            // Creating a student straight from a family or class page links them in the same transaction.
            if (input.status !== "active") throw new AdminError("New students must be active to join a family or class.");
            ix.persons.set(id, { id, kind: "student", displayName: input.displayName, normalizedLoginEmail: null, status: "active", createdAt: now, updatedAt: now });
            const family = ix.families.has(input.groupId);
            if (!family && !ix.classes.has(input.groupId)) throw new AdminError("Choose an existing family or class.");
            await addMembership(family, input.groupId, id, family ? "child" : "student", input.startsOn, input.endsOn, []);
            landing = `/admin/${family ? "families" : "classes"}/${input.groupId}`;
          }
        }
      } else if (input.kind === "end-memberships") {
        const ended: string[] = [];
        for (const membershipId of input.membershipIds) {
          const familyLink = data.familyLinks.find(l => l.id === membershipId), classLink = data.classLinks.find(l => l.id === membershipId);
          if (!familyLink && !classLink) throw new AdminError("Membership not found.", 404);
          if (isDevelopmentIdentity((familyLink ?? classLink)!.personId)) throw new AdminError("Development identities are managed by their seeder.", 403);
          if ((familyLink ?? classLink)!.status !== "active") continue;
          if (familyLink) await tx.update(familyMemberships).set({ status: "inactive", updatedAt: now }).where(eq(familyMemberships.id, membershipId));
          else await tx.update(classMemberships).set({ status: "inactive", updatedAt: now }).where(eq(classMemberships.id, membershipId));
          ended.push(membershipId);
        }
        const first = data.familyLinks.find(l => l.id === input.membershipIds[0]) ?? data.classLinks.find(l => l.id === input.membershipIds[0]);
        section = first && "familyId" in first ? "families" : "classes";
        landing = first ? `/admin/${section}/${"familyId" in first ? first.familyId : first.classId}` : "";
        before = input.membershipIds; after = { ended };
      } else if (input.kind === "class-transfer") {
        section = "classes";
        const moved: { from: string; to: string }[] = [], added: { groupId: string; personId: string; startsOn: string | null; endsOn: string | null }[] = [];
        for (const membershipId of input.membershipIds) {
          const link = data.classLinks.find(l => l.id === membershipId);
          if (!link) throw new AdminError("Enrollment not found.", 404);
          if (link.status !== "active") throw new AdminError("Only active enrollments can be moved.");
          if (link.classId === input.groupId) throw new AdminError("Choose a different destination class.");
          await tx.update(classMemberships).set({ status: "inactive", updatedAt: now }).where(eq(classMemberships.id, membershipId));
          moved.push({ from: membershipId, to: await addMembership(false, input.groupId, link.personId, link.relationship, input.startsOn, input.endsOn, added) });
        }
        before = input.membershipIds; after = { classId: input.groupId, moved };
        landing = `/admin/classes/${input.groupId}`;
      } else {
        const family = input.kind === "family-member";
        section = family ? "families" : "classes";
        landing = `/admin/${section}/${input.groupId}`;
        if (input.id) {
          const links = family ? data.familyLinks.map(r => ({ ...r, groupId: r.familyId })) : data.classLinks.map(r => ({ ...r, groupId: r.classId }));
          const previous = links.find(r => r.id === id); before = previous;
          if (!previous || previous.groupId !== input.groupId || (input.personId && previous.personId !== input.personId) || (input.relationship && previous.relationship !== input.relationship)) throw new AdminError("Membership identity cannot be changed. End the old membership and add a new one.");
          const group = (family ? ix.families : ix.classes).get(previous.groupId), person = ix.persons.get(previous.personId);
          if (isDevelopmentIdentity(previous.personId)) throw new AdminError("Development identities are managed by their seeder.", 403);
          if (input.status === "active" && (group?.status !== "active" || person?.status !== "active")) throw new AdminError("Activate the person and group before assigning membership.");
          if (input.status === "active" && links.some(r => r.id !== id && r.groupId === previous.groupId && r.personId === previous.personId && r.status === "active" && (!r.endsOn || !input.startsOn || r.endsOn >= input.startsOn) && (!input.endsOn || !r.startsOn || input.endsOn >= r.startsOn))) throw new AdminError("This person already has an overlapping membership in this group.", 409);
          const values = membershipValues(input.status as "active" | "inactive", input.startsOn, input.endsOn);
          if (family) await tx.update(familyMemberships).set(values).where(eq(familyMemberships.id, id));
          else await tx.update(classMemberships).set(values).where(eq(classMemberships.id, id));
        } else {
          if (input.status !== "active") throw new AdminError("New memberships start active. End a membership from its group page instead.");
          const added: { groupId: string; personId: string; startsOn: string | null; endsOn: string | null }[] = [];
          const ids = [...new Set([...input.personIds, input.personId].filter(Boolean))];
          const created: string[] = [];
          for (const personId of ids) created.push(await addMembership(family, input.groupId, personId, input.relationship, input.startsOn, input.endsOn, added));
          if (created.length === 1) id = created[0]!;
          after = { ...input, version: undefined, created };
        }
      }
      await tx.insert(auditEvents).values({ eventType: `admin.directory.${input.kind}.${input.id || ["end-memberships", "class-transfer"].includes(input.kind) ? "updated" : "created"}`, actor: actorId, detail: { id, before: before ?? null, after } });
      return { id, section, path: input.returnTo || landing || `/admin/${section}/${id}` };
    });
  }
  return { snapshot: () => relationshipSnapshot(db), save };
}
