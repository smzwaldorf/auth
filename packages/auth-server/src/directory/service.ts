import { loginAllowed } from "../login-policy.js";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

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

type FamilyRelationship = "father" | "mother" | "guardian" | "child";

export type AccessContext = {
  sub: string;
  clientId: string;
  access: "active";
  roles: Array<"admin" | "teacher" | "parent" | "student">;
  familyMemberships: Array<{ familyId: string; relationship: FamilyRelationship }>;
  relatedStudentIds: string[];
  classScopes: { parent: string[]; teacher: string[]; effective: string[] };
};

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
    const ownStudents = new Set(context.relatedStudentIds);
    const teacherCodes = new Set(context.roles.includes("teacher") ? context.classScopes.teacher : []);
    const teacherClasses = new Set(classRows.filter(c=>teacherCodes.has(c.code)).map(c=>c.id));
    const visibleMemberships = memberships.filter(m=>admin || teacherClasses.has(m.classId) || m.relationship === "teacher" || ownStudents.has(m.personId));
    const students = visibleMemberships.filter(m=>m.relationship === "student").map(m=>m.personId);
    const ownFamilies = context.familyMemberships.map(f=>f.familyId);
    const links = await db.select({familyId:familyMemberships.familyId,personId:familyMemberships.personId,relationship:familyMemberships.relationship}).from(familyMemberships).innerJoin(families,eq(families.id,familyMemberships.familyId)).innerJoin(people,eq(people.id,familyMemberships.personId)).where(and(activeFamily,eq(families.status,"active"),eq(people.status,"active")));
    const allowedFamilies = new Set(admin ? links.map(l=>l.familyId) : [...ownFamilies,...links.filter(l=>l.relationship === "child" && students.includes(l.personId)).map(l=>l.familyId)]);
    const familyLinks = links.filter(l=>allowedFamilies.has(l.familyId) && (admin || ownFamilies.includes(l.familyId) || l.relationship !== "child" || students.includes(l.personId)));
    const personIds = [...new Set([personId,...familyLinks.map(l=>l.personId),...visibleMemberships.map(l=>l.personId)])];
    const persons = await db.select({id:people.id,displayName:people.displayName,kind:people.kind}).from(people).where(admin?eq(people.status,"active"):inArray(people.id,personIds));
    const familyRows = await db.select({id:families.id,code:families.code,displayName:families.displayName}).from(families).where(and(eq(families.status,"active"),admin?undefined:inArray(families.id,allowedFamilies.size?[...allowedFamilies]:["00000000-0000-0000-0000-000000000000"])));
    return { ...context, directory: { people:persons, families:familyRows, classes:classRows, familyMemberships:familyLinks, classMemberships:visibleMemberships } };
  }
  return { hasLiveAppAccess, getAccessContext, getDirectoryContext };

}
