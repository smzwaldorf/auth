import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { contactPhoneInput } from "./phone.js";
import { ensurePersonProfile, personProfileData, type ProfileConnection } from "./person-record.js";
import { activeMembership, ProfileError, rows, type ProfileActor } from "./shared.js";

export const householdData = z.object({ mailingAddress: z.string().trim().max(500), contactPhone: contactPhoneInput }).strict();
const relationship = z.enum(["father", "mother", "guardian"]);
export const adultInput = z.object({
  id: z.uuid().nullable(), relationship, removed: z.boolean(), data: personProfileData,
}).strict();
export const familyFormInput = z.object({
  version: z.number().int().nonnegative(), submissionVersion: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(), rosterVersion: z.string().length(64),
  mailingAddress: z.string().trim().min(1).max(500), contactPhone: contactPhoneInput.refine(Boolean),
  adults: z.array(adultInput).min(1).max(30), reason: z.string().trim().max(1000),
}).strict();
export type AdultRow = z.infer<typeof adultInput>;
export async function currentAdults(tx: ProfileConnection, familyId: string) {
  const records = await rows(tx, sql`select p.id,p.display_name,p.kind,p.status,m.id as membership_id,m.relationship,m.starts_on,m.ends_on
    from directory.family_memberships m join directory.people p on p.id=m.person_id
    where m.family_id=${familyId} and ${activeMembership} and p.kind='adult' and p.status='active'
    and m.relationship in ('father','mother','guardian') order by p.id,m.id`);
  const people = [];
  for (const id of [...new Set(records.map(r => r.id as string))]) {
    const memberships = records.filter(r => r.id === id).map(r => ({ id: r.membership_id, relationship: r.relationship, startsOn: r.starts_on, endsOn: r.ends_on }));
    const p = await ensurePersonProfile(tx, id);
    people.push({ id, revision: p.revision, data: p.data, relationship: memberships[0]!.relationship as AdultRow["relationship"], memberships });
  }
  return people;
}
export type CurrentAdult = Awaited<ReturnType<typeof currentAdults>>[number];
export const rosterVersion = (adults: CurrentAdult[]) => createHash("sha256").update(JSON.stringify(adults)).digest("hex");
export async function requirePersonCapability(tx: ProfileConnection, actor: ProfileActor) {
  const [client] = await rows(tx, sql`select 1 from auth.oauth_client where client_id=${actor.clientId} and disabled=false and public=false and metadata->>'personProfiles'='true'`);
  if (!client) throw new ProfileError(403, "此應用程式尚未開放家長資料修改。");
}
export async function validateAdults(tx: ProfileConnection, familyId: string, input: z.infer<typeof familyFormInput>) {
  const current = await currentAdults(tx, familyId);
  if (rosterVersion(current) !== input.rosterVersion) throw new ProfileError(409, "家庭成員或個人資料已更新，請重新載入。");
  const existing = input.adults.filter(a => a.id !== null).map(a => a.id).sort();
  if (JSON.stringify(existing) !== JSON.stringify(current.map(a => a.id).sort()))
    throw new ProfileError(403, "請完整提供目前家庭的成人資料；不能加入其他家庭的個人識別碼。");
  if (!input.adults.some(a => !a.removed)) throw new ProfileError(400, "家庭至少需保留一位家長或監護人。");
  for (const adult of current) {
    const [pending] = await rows(tx, sql`select 1 from directory.person_change_requests where person_id=${adult.id} and status='pending'`);
    if (pending) throw new ProfileError(409, "家庭成員有尚待審核的個人申請，請先完成審核。");
  }
  return current;
}
export async function independentOfAdults(tx: ProfileConnection, actorId: string, adults: CurrentAdult[]) {
  for (const adult of adults) {
    if (adult.id === actorId) return false;
    const [shared] = await rows(tx, sql`select 1 from directory.family_memberships m join directory.families f on f.id=m.family_id
      where m.person_id=${actorId} and m.relationship in ('father','mother','guardian') and ${activeMembership} and f.status='active'
      and m.family_id in (select m.family_id from directory.family_memberships m join directory.families f on f.id=m.family_id
        where m.person_id=${adult.id} and m.relationship in ('father','mother','guardian') and ${activeMembership} and f.status='active')`);
    if (shared) return false;
  }
  return true;
}
/** Caller holds the directory transaction lock; any failure rolls the entire family change back. */
export async function applyAdults(tx: ProfileConnection, familyId: string, requestId: string, submissionVersion: number,
  submittedBy: string, approvedBy: string, adults: AdultRow[], baseline: CurrentAdult[]) {
  const resolved: AdultRow[] = [];
  for (const adult of adults) {
    const prior = baseline.find(a => a.id === adult.id);
    if (adult.removed) {
      if (prior) for (const m of prior.memberships)
        await tx.execute(sql`update directory.family_memberships set status='inactive',updated_at=now() where id=${m.id}`);
      resolved.push(adult);
      continue;
    }
    const id = adult.id ?? randomUUID();
    if (!adult.id) {
      // A contact record is not a login account or an invitation.
      await tx.execute(sql`insert into directory.people(id,kind,display_name) values(${id},'adult',${adult.data.displayName})`);
    }
    const profile = await ensurePersonProfile(tx, id);
    if (!adult.id || JSON.stringify(profile.data) !== JSON.stringify(adult.data)) {
      await tx.execute(sql`update directory.person_profiles set data=${JSON.stringify(adult.data)}::jsonb,revision=revision+1 where person_id=${id}`);
      await tx.execute(sql`update directory.people set display_name=${adult.data.displayName},updated_at=now() where id=${id}`);
      await tx.execute(sql`update auth."user" set name=${adult.data.displayName},updated_at=now() where id=${id}::text`);
      await tx.execute(sql`insert into directory.person_profile_revisions(person_id,revision,data,source,family_request_id,submission_version,submitted_by,approved_by)
        values(${id},${profile.revision + 1},${JSON.stringify(adult.data)}::jsonb,'family',${requestId},${submissionVersion},${submittedBy},${approvedBy})`);
    }
    if (!prior || prior.relationship !== adult.relationship) {
      if (prior) for (const m of prior.memberships)
        await tx.execute(sql`update directory.family_memberships set status='inactive',updated_at=now() where id=${m.id}`);
      await tx.execute(sql`insert into directory.family_memberships(id,family_id,person_id,relationship) values(${randomUUID()},${familyId},${id},${adult.relationship})`);
    }
    resolved.push({ ...adult, id });
  }
  return resolved;
}
