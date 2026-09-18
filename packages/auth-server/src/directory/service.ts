import { loginAllowed } from "../login-policy.js";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import type { Database } from "../db/database.js";
import {
  oauthClient,
  applications,
  classMemberships,
  classes,
  families,
  familyMemberships,
  people,
  personRoles,
} from "../db/schema.js";

export type FamilyRelationship = "father" | "mother" | "guardian" | "child";
export type DeliveryGuardianRelationship = Exclude<FamilyRelationship, "child">;

export type AccessContext = {
  sub: string;
  clientId: string;
  access: "active";
  roles: Array<"admin" | "teacher" | "parent" | "student">;
  familyMemberships: Array<{ familyId: string; relationship: FamilyRelationship }>;
  relatedStudentIds: string[];
  classScopes: { parent: string[]; teacher: string[]; effective: string[] };
};

export type DirectoryClassRow = { id: string; code: string; displayName: string };
export type DirectoryClassMembership = { classId: string; personId: string; relationship: "teacher" | "student" };
export type DirectoryFamilyMembership = { familyId: string; personId: string; relationship: FamilyRelationship };

export type DirectoryScope = {
  allowedFamilyIds: string[];
  familyMemberships: DirectoryFamilyMembership[];
  classMemberships: DirectoryClassMembership[];
  personIds: string[];
};

export type DeliveryContactFamily = {
  familyId: string;
  familyCode: string;
  relationships: DeliveryGuardianRelationship[];
  classIds: string[];
  classCodes: string[];
};

export type DeliveryContact = {
  personId: string;
  displayName: string;
  email: string;
  families: DeliveryContactFamily[];
};

/**
 * Apply the role and relationship boundary to already-live directory rows.
 *
 * Preconditions: the SQL caller has already removed disabled and out-of-date
 * people, families, and memberships, and has restricted classMemberships to
 * the active classes in `classes` (the effective class scope for non-admins).
 * Keeping the remaining visibility decision pure makes the CMS contract
 * reviewable without weakening the live session/app-admission checks.
 */
export function scopeDirectoryRows(input: {
  context: AccessContext;
  personId: string;
  classes: DirectoryClassRow[];
  classMemberships: DirectoryClassMembership[];
  familyMemberships: DirectoryFamilyMembership[];
}): DirectoryScope {
  const admin = input.context.roles.includes("admin");
  const ownFamilies = input.context.familyMemberships.map((membership) => membership.familyId);
  const ownStudents = new Set(input.context.relatedStudentIds);
  const teacherCodes = new Set(input.context.roles.includes("teacher") ? input.context.classScopes.teacher : []);
  const teacherClasses = new Set(input.classes.filter((schoolClass) => teacherCodes.has(schoolClass.code)).map((schoolClass) => schoolClass.id));
  const classMemberships = input.classMemberships.filter((membership) =>
    admin || teacherClasses.has(membership.classId) || membership.relationship === "teacher" || ownStudents.has(membership.personId),
  );
  const visibleStudents = new Set(classMemberships.filter((membership) => membership.relationship === "student").map((membership) => membership.personId));
  const allowedFamilyIds = new Set(
    admin
      ? input.familyMemberships.map((membership) => membership.familyId)
      : [...ownFamilies, ...input.familyMemberships.filter((membership) => membership.relationship === "child" && visibleStudents.has(membership.personId)).map((membership) => membership.familyId)],
  );
  const familyMemberships = input.familyMemberships.filter((membership) =>
    allowedFamilyIds.has(membership.familyId) && (admin || ownFamilies.includes(membership.familyId) || membership.relationship !== "child" || visibleStudents.has(membership.personId)),
  );
  const personIds = [...new Set([input.personId, ...familyMemberships.map((membership) => membership.personId), ...classMemberships.map((membership) => membership.personId)])].sort();
  return {
    allowedFamilyIds: [...allowedFamilyIds].sort(),
    familyMemberships,
    classMemberships,
    personIds,
  };
}

export function assembleAccessContext(input: {
  personId: string;
  clientId: string;
  roles: AccessContext["roles"];
  ownFamilies: AccessContext["familyMemberships"];
  relatedStudentIds: string[];
  parentClassCodes: string[];
  teacherClassCodes: string[];
}): AccessContext {
  const parent = [...new Set(input.parentClassCodes)].sort();
  const teacher = [...new Set(input.teacherClassCodes)].sort();
  return {
    sub: input.personId,
    clientId: input.clientId,
    access: "active",
    roles: [...new Set(input.roles)].sort(),
    familyMemberships: input.ownFamilies
      .map((membership) => ({ ...membership }))
      .sort((left, right) => `${left.familyId}:${left.relationship}`.localeCompare(`${right.familyId}:${right.relationship}`)),
    relatedStudentIds: [...new Set(input.relatedStudentIds)].sort(),
    classScopes: { parent, teacher, effective: [...new Set([...parent, ...teacher])].sort() },
  };
}

function todayUtc(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

import type { RuntimeConfig } from "../runtime-config.js";
import { isDevelopmentIdentity } from "../development/policy.js";
import { validDevelopmentIdentity } from "../development/identity.js";

export function createDirectory(db: Database, config?: RuntimeConfig) {
  async function hasLiveAppAccess(personId: string, clientId: string): Promise<boolean> {
    if (isDevelopmentIdentity(personId) && (!config || !(await validDevelopmentIdentity(db, config, personId)))) return false;
    if (!isDevelopmentIdentity(personId) && !(await loginAllowed(db, config ?? {} as RuntimeConfig, personId))) return false;
    const [row] = await db.select({ enabled: applications.enabled, disabled: oauthClient.disabled })
      .from(applications).innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId))
      .where(eq(applications.clientId, clientId)).limit(1);
    return row?.enabled === true && row.disabled === false;
  }

  async function getAccessContext(personId: string, clientId: string, at = new Date()): Promise<AccessContext | null> {
    if (!(await hasLiveAppAccess(personId, clientId))) return null;
    const date = todayUtc(at);
    const activeFamilyOnDate = and(
      eq(familyMemberships.status, "active"),
      or(isNull(familyMemberships.startsOn), lte(familyMemberships.startsOn, date)),
      or(isNull(familyMemberships.endsOn), gte(familyMemberships.endsOn, date)),
    );
    const activeClassOnDate = and(
      eq(classMemberships.status, "active"),
      or(isNull(classMemberships.startsOn), lte(classMemberships.startsOn, date)),
      or(isNull(classMemberships.endsOn), gte(classMemberships.endsOn, date)),
    );

    const [roles, ownFamilies, teacherClasses] = await Promise.all([
      db.select({ role: personRoles.role }).from(personRoles).where(eq(personRoles.personId, personId)),
      db
        .select({ familyId: familyMemberships.familyId, relationship: familyMemberships.relationship })
        .from(familyMemberships)
        .innerJoin(families, and(eq(families.id, familyMemberships.familyId), eq(families.status, "active")))
        .where(and(eq(familyMemberships.personId, personId), activeFamilyOnDate)),
      db
        .select({ code: classes.code })
        .from(classMemberships)
        .innerJoin(classes, and(eq(classes.id, classMemberships.classId), eq(classes.status, "active")))
        .where(
          and(
            eq(classMemberships.personId, personId),
            eq(classMemberships.relationship, "teacher"),
            activeClassOnDate,
          ),
        ),
    ]);

    const familyIds = ownFamilies.map((membership) => membership.familyId);
    const relatedStudents = familyIds.length
      ? await db
          .select({ personId: familyMemberships.personId })
          .from(familyMemberships)
          .innerJoin(people, and(eq(people.id, familyMemberships.personId), eq(people.kind, "student"), eq(people.status, "active")))
          .where(
            and(
              inArray(familyMemberships.familyId, familyIds),
              eq(familyMemberships.relationship, "child"),
              activeFamilyOnDate,
            ),
          )
      : [];
    const relatedStudentIds = [...new Set(relatedStudents.map((student) => student.personId))].sort();

    const parentClasses = relatedStudentIds.length
      ? await db
          .select({ code: classes.code })
          .from(classMemberships)
          .innerJoin(classes, and(eq(classes.id, classMemberships.classId), eq(classes.status, "active")))
          .where(
            and(
              inArray(classMemberships.personId, relatedStudentIds),
              eq(classMemberships.relationship, "student"),
              activeClassOnDate,
            ),
          )
      : [];

    return assembleAccessContext({
      personId,
      clientId,
      roles: roles.map((role) => role.role),
      ownFamilies: ownFamilies.map((membership) => ({ familyId: membership.familyId, relationship: membership.relationship })),
      relatedStudentIds,
      parentClassCodes: parentClasses.map((schoolClass) => schoolClass.code),
      teacherClassCodes: teacherClasses.map((schoolClass) => schoolClass.code),
    });
  }

  async function getDirectoryContext(personId: string, clientId: string) {
    const context = await getAccessContext(personId, clientId);
    if (!context) return null;
    const date = todayUtc();
    const activeFamily = and(eq(familyMemberships.status, "active"), or(isNull(familyMemberships.startsOn), lte(familyMemberships.startsOn,date)), or(isNull(familyMemberships.endsOn),gte(familyMemberships.endsOn,date)));
    const activeClass = and(eq(classMemberships.status, "active"), or(isNull(classMemberships.startsOn),lte(classMemberships.startsOn,date)), or(isNull(classMemberships.endsOn),gte(classMemberships.endsOn,date)));
    const admin = context.roles.includes("admin");
    const classRows = await db.select({id:classes.id,code:classes.code,displayName:classes.displayName}).from(classes).where(and(eq(classes.status,"active"),admin?undefined:inArray(classes.code,context.classScopes.effective.length?context.classScopes.effective:[""])));
    const classIds = classRows.map(r=>r.id);
    const memberships = classIds.length ? await db.select({classId:classMemberships.classId,personId:classMemberships.personId,relationship:classMemberships.relationship}).from(classMemberships).innerJoin(people,eq(people.id,classMemberships.personId)).where(and(inArray(classMemberships.classId,classIds),activeClass,eq(people.status,"active"))) : [];
    const links = await db.select({familyId:familyMemberships.familyId,personId:familyMemberships.personId,relationship:familyMemberships.relationship}).from(familyMemberships).innerJoin(families,eq(families.id,familyMemberships.familyId)).innerJoin(people,eq(people.id,familyMemberships.personId)).where(and(activeFamily,eq(families.status,"active"),eq(people.status,"active")));
    const scoped = scopeDirectoryRows({ context, personId, classes: classRows, classMemberships: memberships, familyMemberships: links });
    const persons = await db.select({id:people.id,displayName:people.displayName,kind:people.kind}).from(people).where(admin?eq(people.status,"active"):inArray(people.id,scoped.personIds));
    const familyRows = await db.select({id:families.id,code:families.code,displayName:families.displayName}).from(families).where(and(eq(families.status,"active"),admin?undefined:inArray(families.id,scoped.allowedFamilyIds.length?scoped.allowedFamilyIds:["00000000-0000-0000-0000-000000000000"])));
    return { ...context, directory: { people:persons, families:familyRows, classes:classRows, familyMemberships:scoped.familyMemberships, classMemberships:scoped.classMemberships } };
  }

  async function getDeliveryContacts(at = new Date()): Promise<DeliveryContact[]> {
    const date = todayUtc(at);
    const activeFamilyOnDate = and(
      eq(familyMemberships.status, "active"),
      or(isNull(familyMemberships.startsOn), lte(familyMemberships.startsOn, date)),
      or(isNull(familyMemberships.endsOn), gte(familyMemberships.endsOn, date)),
    );
    const activeClassOnDate = and(
      eq(classMemberships.status, "active"),
      or(isNull(classMemberships.startsOn), lte(classMemberships.startsOn, date)),
      or(isNull(classMemberships.endsOn), gte(classMemberships.endsOn, date)),
    );
    const guardianRows = await db
      .select({
        personId: people.id,
        displayName: people.displayName,
        email: people.normalizedLoginEmail,
        familyId: families.id,
        familyCode: families.code,
        relationship: familyMemberships.relationship,
      })
      .from(familyMemberships)
      .innerJoin(families, and(eq(families.id, familyMemberships.familyId), eq(families.status, "active")))
      .innerJoin(people, and(
        eq(people.id, familyMemberships.personId),
        eq(people.kind, "adult"),
        eq(people.status, "active"),
        isNotNull(people.normalizedLoginEmail),
      ))
      .where(and(
        activeFamilyOnDate,
        inArray(familyMemberships.relationship, ["father", "mother", "guardian"]),
      ))
      .orderBy(people.id, families.id);

    const familyIds = [...new Set(guardianRows.map(row => row.familyId))];
    const classRows = familyIds.length
      ? await db
          .select({
            familyId: familyMemberships.familyId,
            classId: classes.id,
            classCode: classes.code,
          })
          .from(familyMemberships)
          .innerJoin(people, and(
            eq(people.id, familyMemberships.personId),
            eq(people.kind, "student"),
            eq(people.status, "active"),
          ))
          .innerJoin(classMemberships, and(
            eq(classMemberships.personId, people.id),
            eq(classMemberships.relationship, "student"),
            activeClassOnDate,
          ))
          .innerJoin(classes, and(eq(classes.id, classMemberships.classId), eq(classes.status, "active")))
          .where(and(
            inArray(familyMemberships.familyId, familyIds),
            eq(familyMemberships.relationship, "child"),
            activeFamilyOnDate,
          ))
          .orderBy(familyMemberships.familyId, classes.id)
      : [];

    const familiesById = new Map<string, DeliveryContactFamily[]>();
    const contactsByPerson = new Map<string, DeliveryContact & { familiesById: Map<string, DeliveryContactFamily> }>();
    for (const row of guardianRows) {
      if (!row.email) continue;
      const contact: DeliveryContact & { familiesById: Map<string, DeliveryContactFamily> } = contactsByPerson.get(row.personId) ?? {
        personId: row.personId,
        displayName: row.displayName,
        email: row.email,
        families: [] as DeliveryContactFamily[],
        familiesById: new Map<string, DeliveryContactFamily>(),
      };
      let family = contact.familiesById.get(row.familyId);
      if (!family) {
        family = {
          familyId: row.familyId,
          familyCode: row.familyCode,
          relationships: [],
          classIds: [],
          classCodes: [],
        };
        contact.familiesById.set(row.familyId, family);
        contact.families.push(family);
        const familyContacts = familiesById.get(row.familyId) ?? [];
        familyContacts.push(family);
        familiesById.set(row.familyId, familyContacts);
      }
      if (!family.relationships.includes(row.relationship as DeliveryGuardianRelationship)) {
        family.relationships.push(row.relationship as DeliveryGuardianRelationship);
      }
      contactsByPerson.set(row.personId, contact);
    }
    for (const row of classRows) {
      for (const family of familiesById.get(row.familyId) ?? []) {
        if (!family.classIds.includes(row.classId)) family.classIds.push(row.classId);
        if (!family.classCodes.includes(row.classCode)) family.classCodes.push(row.classCode);
      }
    }

    return [...contactsByPerson.values()]
      .map(({ familiesById: _familiesById, ...contact }) => ({
        ...contact,
        families: contact.families
          .map(family => ({
            ...family,
            relationships: [...family.relationships].sort(),
            classIds: [...family.classIds].sort(),
            classCodes: [...family.classCodes].sort(),
          }))
          .sort((left, right) => left.familyId.localeCompare(right.familyId)),
      }))
      .sort((left, right) => left.personId.localeCompare(right.personId));
  }

  return { hasLiveAppAccess, getAccessContext, getDirectoryContext, getDeliveryContacts };

}
