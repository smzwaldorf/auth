import { eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, user, loginInvitations, personRoles, families, classes, familyMemberships, classMemberships, applications } from "../db/schema.js";
import { developmentIdentities, developmentLoginEnabled } from "./policy.js";
import { createDevelopmentSeeder } from "./seed.js";
export const schoolIds = {
  alton: "26dbb5dd-2796-43a4-9fda-e46ba2ca0b20", caton: "38dcc1bc-a23b-429d-ade6-46e1abc3a7e2",
  altonClass: "18019dd3-0c07-4f82-a885-8ce3865e5c24", catonClass: "24fd7ed9-1170-412a-a61d-037e2835156a",
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
      { id: schoolIds.alton, kind: "student" as const, displayName: "Alton", normalizedLoginEmail: null, role: "student" as const },
      { id: schoolIds.caton, kind: "student" as const, displayName: "Caton", normalizedLoginEmail: null, role: "student" as const },
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
    for(const [index,personId] of [schoolIds.parent,schoolIds.studentOne,schoolIds.studentTwo].entries()) await tx.insert(familyMemberships).values({id:`d3100000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,familyId:schoolIds.family,personId,relationship:index===0?"guardian":"child",status:index===0?"active":"inactive"}).onConflictDoNothing({target:familyMemberships.id});
    // Preserve the IDs and enrollment dates from the current local school setup.
    const students = [
      { personId: schoolIds.alton, classId: schoolIds.altonClass, code: "smz110b", name: "辛丑乙", startsOn: "2020-11-01", familyLinkId: "3d24f73e-2eba-4eb6-a2dd-a0e84db3ab54", classLinkId: "52c6ead1-98a1-425f-831a-5a6ddc81c14b" },
      { personId: schoolIds.caton, classId: schoolIds.catonClass, code: "smz113", name: "甲辰", startsOn: "2024-09-01", familyLinkId: "cf99e7bb-2dd3-404a-9442-fd8ad45eedb9", classLinkId: "79c764d2-fe56-4079-8e95-8eb5ab8f7faf" },
    ];
    for (const student of students) {
      await tx.insert(classes).values({ id: student.classId, code: student.code, displayName: student.name }).onConflictDoNothing({ target: classes.id });
      await tx.insert(familyMemberships).values({ id: student.familyLinkId, familyId: schoolIds.family, personId: student.personId, relationship: "child" }).onConflictDoNothing({ target: familyMemberships.id });
      await tx.insert(classMemberships).values({ id: student.classLinkId, classId: student.classId, personId: student.personId, relationship: "student", startsOn: student.startsOn }).onConflictDoNothing({ target: classMemberships.id });
    }
    for(const [index,personId] of [developmentIdentities.schoolTeacher.id,schoolIds.studentOne,schoolIds.studentTwo].entries()) await tx.insert(classMemberships).values({id:`d4100000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,classId:schoolIds.class,personId,relationship:index===0?"teacher":"student"}).onConflictDoNothing({target:classMemberships.id});
  });
}
