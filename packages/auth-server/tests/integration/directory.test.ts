import fs from "node:fs";
import path from "node:path";

import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../../src/db/client.js";
import { appAccess, auditEvents, classMemberships } from "../../src/db/schema.js";
import { getAccessContext } from "../../src/directory/access-context.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
import { validateDirectorySeed } from "../../src/seed/model.js";

const enabled = process.env.RUN_DB_TESTS === "true";
const adultId = "10000000-0000-4000-8000-000000000001";
const gradeFourMembershipId = "41000000-0000-4000-8000-000000000001";
const seed = validateDirectorySeed(
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "seeds/directory.seed.example.json"), "utf8")) as unknown,
);

describe.runIf(enabled).sequential("live PostgreSQL directory", () => {
  beforeAll(async () => applyDirectorySeed(seed));
  afterAll(async () => closeDatabase());

  it("returns the parent and teacher scope union for a dual-role adult", async () => {
    const context = await getAccessContext(adultId, "vite-app", new Date("2026-08-15T00:00:00Z"));
    expect(context).toMatchObject({
      roles: ["parent", "teacher"],
      relatedStudentIds: ["10000000-0000-4000-8000-000000000002"],
      classScopes: { parent: ["G4"], teacher: ["G6"], effective: ["G4", "G6"] },
    });
  });

  it("is idempotent, including its audit record", async () => {
    await applyDirectorySeed(seed);
    await applyDirectorySeed(seed);
    const [auditCount] = await db.select({ value: count() }).from(auditEvents).where(eq(auditEvents.eventType, "directory.seed.applied"));
    expect(auditCount?.value).toBe(1);
  });

  it("filters inactive class relationships live", async () => {
    await db.update(classMemberships).set({ status: "inactive" }).where(eq(classMemberships.id, gradeFourMembershipId));
    const context = await getAccessContext(adultId, "vite-app", new Date("2026-08-15T00:00:00Z"));
    expect(context?.classScopes).toEqual({ parent: [], teacher: ["G6"], effective: ["G6"] });
    await db.update(classMemberships).set({ status: "active" }).where(eq(classMemberships.id, gradeFourMembershipId));
  });

  it("blocks revoked app access immediately", async () => {
    await db.update(appAccess).set({ status: "revoked" }).where(eq(appAccess.personId, adultId));
    expect(await getAccessContext(adultId, "vite-app")).toBeNull();
    await applyDirectorySeed(seed);
    expect(await getAccessContext(adultId, "vite-app")).not.toBeNull();
  });
});
