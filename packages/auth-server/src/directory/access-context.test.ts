import { describe, expect, it } from "vitest";

import { assembleAccessContext } from "./access-context.js";
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
