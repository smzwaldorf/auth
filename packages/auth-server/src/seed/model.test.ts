import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isEligibleAuthenticationPerson, isEligibleLoginPerson } from "../auth.js";
import { normalizeEmail, seedSummary, validateDirectorySeed } from "./model.js";

const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../seeds/directory.seed.example.json");
const example = JSON.parse(fs.readFileSync(seedPath, "utf8")) as Record<string, unknown>;

describe("directory seed validation", () => {
  it("accepts the placeholder single-school seed and normalizes email", () => {
    const seed = validateDirectorySeed(example);
    expect(seedSummary(seed)).toMatchObject({ adults: 3, students: 1, families: 1, classes: 2, applications: 3 });
    expect(normalizeEmail(" Approved.Guardian@Example.Invalid ")).toBe("approved.guardian@example.invalid");
  });

  it("rejects a student login", () => {
    const broken = structuredClone(example) as any;
    const student = broken.people.find((person: { roles: string[] }) => person.roles.includes("student"));
    student.loginEmail = "student@example.invalid";
    student.invitation = { id: "20000000-0000-4000-8000-000000000002" };
    expect(() => validateDirectorySeed(broken)).toThrow("cannot have login credentials");
  });

  it("rejects unknown relationships and duplicate app access", () => {
    const broken = structuredClone(example) as any;
    broken.families[0].memberships[0].personId = "90000000-0000-4000-8000-000000000009";
    broken.appAccess.push(structuredClone(broken.appAccess[0]));
    expect(() => validateDirectorySeed(broken)).toThrow(/unknown person[\s\S]*duplicate app access/);
  });

  it("rejects class and family intervals that end before they start", () => {
    const broken = structuredClone(example) as any;
    broken.families[0].memberships[0].startsOn = "2026-08-15";
    broken.families[0].memberships[0].endsOn = "2026-08-14";
    broken.classes[0].memberships[0].startsOn = "2026-08-15";
    broken.classes[0].memberships[0].endsOn = "2026-08-14";
    expect(() => validateDirectorySeed(broken)).toThrow(/family membership[\s\S]*class membership/);
  });

  it("allows development login only for active parent or teacher adults", () => {
    const disabled = structuredClone(example) as any;
    disabled.people[0].status = "disabled";
    expect(() => validateDirectorySeed(disabled)).toThrow("cannot be a development login");

    const unsupported = structuredClone(example) as any;
    unsupported.people[0].roles = ["admin"];
    expect(() => validateDirectorySeed(unsupported)).toThrow("must be a parent or teacher");
  });

  it("keeps administrators out of application login while allowing central admin authentication", () => {
    const administrator = { kind: "adult" as const, status: "active" as const, roles: ["admin"] };
    expect(isEligibleLoginPerson(administrator)).toBe(false);
    expect(isEligibleAuthenticationPerson(administrator)).toBe(true);
  });
});
