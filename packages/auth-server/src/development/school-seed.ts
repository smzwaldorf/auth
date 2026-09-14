import { eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, user, loginInvitations, personRoles, families, classes, familyMemberships, classMemberships, applications } from "../db/schema.js";
import { developmentIdentities, developmentLoginEnabled } from "./policy.js";
import { createDevelopmentSeeder } from "./seed.js";
export const schoolIds = {
  parent: "d2000000-0000-4000-8000-000000000001", studentOne: "d2000000-0000-4000-8000-000000000002", studentTwo: "d2000000-0000-4000-8000-000000000003",
  family: "d3000000-0000-4000-8000-000000000001", class: "d4000000-0000-4000-8000-000000000001",
};
export async function seedSchool(db: Database, config: RuntimeConfig, parentEmail: string) {
  if (!developmentLoginEnabled(config)) throw new Error("School seed requires an explicitly enabled local development database.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) throw new Error("Set DEV_PARENT_EMAIL to the confirmed parent email.");
  const [cms] = await db.select().from(applications).where(eq(applications.clientId, "email-cms"));
  if (!cms) throw new Error("Register CMS before running the school seed.");
  await createDevelopmentSeeder(db, config, { trustedClientIds: new Set(["email-cms"]) })();
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
    const records = [
      { id: schoolIds.parent, kind: "adult" as const, displayName: "Harry", normalizedLoginEmail: parentEmail.toLowerCase(), role: "parent" as const },
      { id: schoolIds.studentOne, kind: "student" as const, displayName: "Demo Student One", normalizedLoginEmail: null, role: "student" as const },
      { id: schoolIds.studentTwo, kind: "student" as const, displayName: "Demo Student Two", normalizedLoginEmail: null, role: "student" as const },
    ];
    for (const r of records) {
      const existing = await tx.select().from(people).where(r.normalizedLoginEmail ? or(eq(people.id,r.id),eq(people.normalizedLoginEmail,r.normalizedLoginEmail)) : eq(people.id,r.id));
      if (existing.length && (existing.length !== 1 || existing[0]!.id !== r.id || existing[0]!.kind !== r.kind || existing[0]!.normalizedLoginEmail !== r.normalizedLoginEmail)) throw new Error("School seed identity collision; no school records changed.");
      if (!existing.length) {
        await tx.insert(people).values({ id:r.id,kind:r.kind,displayName:r.displayName,normalizedLoginEmail:r.normalizedLoginEmail });
        await tx.insert(personRoles).values({personId:r.id,role:r.role});
        if(r.normalizedLoginEmail){
          await tx.insert(user).values({id:r.id,name:r.displayName,email:r.normalizedLoginEmail,emailVerified:false});
          await tx.insert(loginInvitations).values({id:"d2100000-0000-4000-8000-000000000001",personId:r.id,normalizedEmail:r.normalizedLoginEmail,status:"pending"});
        }
      }
    }
    await tx.insert(families).values({id:schoolIds.family,code:"DEV-HARRY",displayName:"Harry's Demo Family"}).onConflictDoNothing({target:families.id});
    await tx.insert(classes).values({id:schoolIds.class,code:"DEV-G1",displayName:"Development Grade 1"}).onConflictDoNothing({target:classes.id});
    for(const [index,personId] of [schoolIds.parent,schoolIds.studentOne,schoolIds.studentTwo].entries()) await tx.insert(familyMemberships).values({id:`d3100000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,familyId:schoolIds.family,personId,relationship:index===0?"guardian":"child"}).onConflictDoNothing({target:familyMemberships.id});
    for(const [index,personId] of [developmentIdentities.schoolTeacher.id,schoolIds.studentOne,schoolIds.studentTwo].entries()) await tx.insert(classMemberships).values({id:`d4100000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,classId:schoolIds.class,personId,relationship:index===0?"teacher":"student"}).onConflictDoNothing({target:classMemberships.id});
  });
}
