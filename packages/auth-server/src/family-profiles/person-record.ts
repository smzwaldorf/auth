import { contactPhoneInput } from "./phone.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import { ProfileError, rows } from "./shared.js";
export const personProfileData = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    contactPhone: contactPhoneInput,
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine(
        (v) => !v || z.email().safeParse(v).success,
        "聯絡信箱格式不正確。",
      ),
  })
  .strict();
export type PersonProfileData = z.infer<typeof personProfileData>;
export type ProfileConnection = Pick<Database, "execute">;
/** Caller holds the directory write lock. Capture a baseline before any approved changes. */
export async function ensurePersonProfile(
  tx: ProfileConnection,
  personId: string,
) {
  const [person] = await rows(
    tx,
    sql`select id,display_name from directory.people where id=${personId} and kind='adult' for update`,
  );
  if (!person) throw new ProfileError(404, "找不到成人資料。");
  const data: PersonProfileData = {
    displayName: person.display_name,
    contactPhone: "",
    contactEmail: "",
  };
  await tx.execute(
    sql`insert into directory.person_profiles(person_id,data) values(${personId},${JSON.stringify(data)}::jsonb) on conflict do nothing`,
  );
  const [profile] = await rows(
    tx,
    sql`select revision,data from directory.person_profiles where person_id=${personId} for update`,
  );
  if (!profile) throw new ProfileError(409, "請重新載入個人資料。");
  await tx.execute(
    sql`insert into directory.person_profile_revisions(person_id,revision,data,source) select ${personId}::uuid,0,${JSON.stringify(profile.data)}::jsonb,'baseline' where ${profile.revision}=0 on conflict do nothing`,
  );
  if (profile.data.displayName !== person.display_name)
    throw new ProfileError(409, "姓名與正式紀錄不一致，請聯絡管理員確認。");
  return {
    revision: profile.revision as number,
    data: personProfileData.parse(profile.data),
  };
}
/** Administrative name edits are already authorized by adminService; preserve them as revisions. */
export async function recordAdministrativeName(
  tx: ProfileConnection,
  personId: string,
  actorId: string,
  displayName: string,
) {
  const current = await ensurePersonProfile(tx, personId);
  if (current.data.displayName === displayName) return;
  if (personId === actorId)
    throw new ProfileError(403, "自己的姓名變更須由另一位審核人員核准。");
  const data = personProfileData.parse({ ...current.data, displayName });
  await tx.execute(
    sql`update directory.person_profiles set revision=revision+1,data=${JSON.stringify(data)}::jsonb where person_id=${personId}`,
  );
  await tx.execute(
    sql`insert into directory.person_profile_revisions(person_id,revision,data,source,approved_by) values(${personId},${current.revision + 1},${JSON.stringify(data)}::jsonb,'admin',${actorId})`,
  );
}
