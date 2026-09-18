import { describe, expect, it } from "vitest";

import { assembleAccessContext } from "./access-context.js";
import { scopeDirectoryRows } from "./service.js";
import { hasOnlyExpectedAudiences } from "./token-policy.js";

describe("access context assembly", () => {
  it("resolves multi-role adults, multiple families, and a deduplicated class-scope union", () => {
    const context = assembleAccessContext({
      personId: "person-1",
      clientId: "vite-app",
      roles: ["teacher", "parent", "teacher"],
      ownFamilies: [
        { familyId: "family-2", relationship: "father" },
        { familyId: "family-1", relationship: "guardian" },
      ],
      relatedStudentIds: ["student-2", "student-1", "student-1"],
      parentClassCodes: ["G4", "G5", "G4"],
      teacherClassCodes: ["G6", "G5"],
    });

    expect(context.roles).toEqual(["parent", "teacher"]);
    expect(context.relatedStudentIds).toEqual(["student-1", "student-2"]);
    expect(context.classScopes).toEqual({ parent: ["G4", "G5"], teacher: ["G5", "G6"], effective: ["G4", "G5", "G6"] });
    expect(context.familyMemberships[0]?.familyId).toBe("family-1");
  });
});

describe("resource audience policy", () => {
  it("accepts only the directory and optional OIDC UserInfo audiences", () => {
    expect(hasOnlyExpectedAudiences("smz-directory", "smz-directory", "https://issuer/userinfo")).toBe(true);
    expect(hasOnlyExpectedAudiences(["smz-directory", "https://issuer/userinfo"], "smz-directory", "https://issuer/userinfo")).toBe(true);
    expect(hasOnlyExpectedAudiences(["smz-directory", "unexpected-api"], "smz-directory", "https://issuer/userinfo")).toBe(false);
  });
});

describe("directory visibility contract", () => {
  const classes = [
    { id: "class-1", code: "G1", displayName: "Grade 1" },
    { id: "class-2", code: "G2", displayName: "Grade 2" },
  ];
  const classMemberships = [
    { classId: "class-1", personId: "student-own", relationship: "student" as const },
    { classId: "class-1", personId: "teacher-1", relationship: "teacher" as const },
    { classId: "class-1", personId: "student-other", relationship: "student" as const },
    { classId: "class-2", personId: "student-hidden", relationship: "student" as const },
  ];
  const familyMemberships = [
    { familyId: "family-own", personId: "parent-1", relationship: "guardian" as const },
    { familyId: "family-own", personId: "student-own", relationship: "child" as const },
    { familyId: "family-other", personId: "parent-2", relationship: "guardian" as const },
    { familyId: "family-other", personId: "student-other", relationship: "child" as const },
    { familyId: "family-hidden", personId: "student-hidden", relationship: "child" as const },
  ];

  it("keeps a parent on their family and class teachers, without exposing classmates' families", () => {
    const scoped = scopeDirectoryRows({
      personId: "parent-1",
      classes: [classes[0]!],
      classMemberships,
      familyMemberships,
      context: assembleAccessContext({
        personId: "parent-1",
        clientId: "email-cms",
        roles: ["parent"],
        ownFamilies: [{ familyId: "family-own", relationship: "guardian" }],
        relatedStudentIds: ["student-own"],
        parentClassCodes: ["G1"],
        teacherClassCodes: [],
      }),
    });

    expect(scoped.allowedFamilyIds).toEqual(["family-own"]);
    expect(scoped.familyMemberships.map((membership) => membership.familyId)).toEqual(["family-own", "family-own"]);
    expect(scoped.classMemberships).toEqual([
      classMemberships[0],
      classMemberships[1],
    ]);
    expect(scoped.personIds).toEqual(["parent-1", "student-own", "teacher-1"]);
  });

  it("lets a teacher see assigned-class families and keeps unrelated classes out", () => {
    const scoped = scopeDirectoryRows({
      personId: "teacher-1",
      classes: [classes[0]!],
      classMemberships,
      familyMemberships,
      context: assembleAccessContext({
        personId: "teacher-1",
        clientId: "email-cms",
        roles: ["teacher"],
        ownFamilies: [],
        relatedStudentIds: [],
        parentClassCodes: [],
        teacherClassCodes: ["G1"],
      }),
    });

    expect(scoped.allowedFamilyIds).toEqual(["family-other", "family-own"]);
    expect(scoped.familyMemberships.map((membership) => membership.familyId)).toEqual([
      "family-own",
      "family-own",
      "family-other",
      "family-other",
    ]);
    expect(scoped.classMemberships).toEqual(classMemberships.slice(0, 3));
    expect(scoped.personIds).toEqual(["parent-1", "parent-2", "student-other", "student-own", "teacher-1"]);
  });

  it("lets an admin see every active row supplied by the live directory query", () => {
    const scoped = scopeDirectoryRows({
      personId: "admin-1",
      classes,
      classMemberships,
      familyMemberships,
      context: assembleAccessContext({
        personId: "admin-1",
        clientId: "email-cms-server",
        roles: ["admin"],
        ownFamilies: [],
        relatedStudentIds: [],
        parentClassCodes: [],
        teacherClassCodes: [],
      }),
    });

    expect(scoped.allowedFamilyIds).toEqual(["family-hidden", "family-other", "family-own"]);
    expect(scoped.familyMemberships).toEqual(familyMemberships);
    expect(scoped.classMemberships).toEqual(classMemberships);
    expect(scoped.personIds).toEqual(["admin-1", "parent-1", "parent-2", "student-hidden", "student-other", "student-own", "teacher-1"]);
  });
});
