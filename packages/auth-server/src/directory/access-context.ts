import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  appAccess,
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

export async function hasLiveAppAccess(personId: string, clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ personStatus: people.status, kind: people.kind, accessStatus: appAccess.status, appEnabled: applications.enabled })
    .from(people)
    .innerJoin(appAccess, and(eq(appAccess.personId, people.id), eq(appAccess.clientId, clientId)))
    .innerJoin(applications, eq(applications.clientId, appAccess.clientId))
    .where(eq(people.id, personId))
    .limit(1);
  return row?.kind === "adult" && row.personStatus === "active" && row.accessStatus === "active" && row.appEnabled;
}

export async function getAccessContext(personId: string, clientId: string, at = new Date()): Promise<AccessContext | null> {
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
