import { householdData, adultInput, familyFormInput, currentAdults, rosterVersion, requirePersonCapability, validateAdults, independentOfAdults, applyAdults } from "./family-bundle.js";
import { loginAllowed } from "../login-policy.js";
import {
  ProfileError,
  profileAccess,
  rows,
  activeMembership,
  type ProfileActor,
} from "./shared.js";
export { ProfileError, type ProfileActor } from "./shared.js";
type Connection = Pick<Database, "execute">;
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";

export const profileData = householdData;
export const saveInput = z
  .object({
    version: z.number().int().positive(),
    baseRevision: z.number().int().nonnegative(),
    data: profileData,
    reason: z.string().trim().max(1000),
  })
  .strict();
export const actionInput = z
  .object({
    version: z.number().int().positive(),
    submissionVersion: z.number().int().nonnegative(),
    reason: z.string().trim().max(1000).default(""),
  })
  .strict();
export function familyProfileService(db: Database, config: RuntimeConfig) {
  const run = profileAccess(db, config, "familyProfiles");
  const requireOwn = (own: string[], familyId: string) => {
    if (!own.includes(familyId))
      throw new ProfileError(403, "您目前沒有此家庭的填寫權限。");
  };
  async function event(
    tx: Connection,
    actor: ProfileActor,
    id: string,
    action: string,
    version: number,
    reason = "",
  ) {
    await tx.execute(
      sql`insert into directory.family_request_events(request_id,action,version,actor_id,reason) values(${id},${action},${version},${actor.personId},${reason})`,
    );
  }
  async function request(tx: Connection, id: string) {
    const [r] = await rows(
      tx,
      sql`select * from directory.family_change_requests where id=${id} for update`,
    );
    if (!r) throw new ProfileError(404, "找不到申請。");
    return r;
  }
  async function memberships(tx: Connection, familyId: string) {
    return (
      await rows(
        tx,
        sql`select m.id from directory.family_memberships m join directory.people p on p.id=m.person_id where m.family_id=${familyId} and m.relationship in ('father','mother','guardian') and ${activeMembership} and p.status='active'`,
      )
    ).map((m) => m.id);
  }
  const canSeeHistory = (row: Record<string, any>, ids: string[]) =>
    (row.viewer_membership_ids as string[]).some((id) => ids.includes(id));
  return {
    async home(actor: ProfileActor) {
      return run(actor, async (tx, access) => ({
        canReview: access.reviewer,
        families: await rows(
          tx,
          sql`select f.id, f.display_name as name, coalesce(p.revision,0) as revision from directory.families f left join directory.family_profiles p on p.family_id=f.id where f.id in (select m.family_id from directory.family_memberships m where m.person_id=${actor.personId} and m.relationship in ('father','mother','guardian') and ${activeMembership}) and f.status='active' order by f.display_name`,
        ),
        reviewFamilies: access.reviewer
          ? await rows(
              tx,
              sql`select f.id,f.display_name as name,p.revision from directory.families f join directory.family_profiles p on p.family_id=f.id where f.status='active' order by f.display_name limit 200`,
            )
          : [],
        queue: access.reviewer
          ? await rows(
              tx,
              sql`select r.id, r.family_id, f.display_name as family_name, r.status, r.updated_at from directory.family_change_requests r join directory.families f on f.id=r.family_id where r.status='pending' and f.status='active' order by r.updated_at limit 200`,
            )
          : [],
      }));
    },
    async profile(actor: ProfileActor, familyId: string) {
      return run(actor, async (tx, access) => {
        if (!access.reviewer) requireOwn(access.own, familyId);
        const [family] = await rows(
          tx,
          sql`select id, display_name as name from directory.families where id=${familyId} and status='active'`,
        );
        if (!family) throw new ProfileError(404, "找不到家庭。");
        const [profile] = await rows(
          tx,
          sql`select revision,data from directory.family_profiles where family_id=${familyId}`,
        );
        const revisions = await rows(
          tx,
          sql`select r.*, a.display_name as approved_name, s.display_name as submitted_name from directory.family_profile_revisions r join directory.people a on a.id=r.approved_by join directory.people s on s.id=r.submitted_by where family_id=${familyId} order by revision desc`,
        );
        const submissions = await rows(
          tx,
          sql`select s.*,r.status from directory.family_request_submissions s join directory.family_change_requests r on r.id=s.request_id where r.family_id=${familyId} order by s.submitted_at desc`,
        );
        const visible = submissions.filter(
          (s) => access.reviewer || canSeeHistory(s, access.membershipIds),
        );
        const open = await rows(
          tx,
          sql`select * from directory.family_change_requests where family_id=${familyId} and status in ('draft','returned','pending')`,
        );
        // New guardians can see current household data but not earlier submitted requests.
        const current = open[0];
        const visibleOpen =
          current &&
          (current.status === "draft" ||
            access.reviewer ||
            visible.some(
              (s) =>
                s.request_id === current.id &&
                s.version === current.submission_version,
            ))
            ? current
            : null;
        const events = await rows(
          tx,
          sql`select e.*,p.display_name as actor_name from directory.family_request_events e join directory.family_change_requests r on r.id=e.request_id join directory.people p on p.id=e.actor_id where r.family_id=${familyId} order by e.occurred_at desc`,
        );
        const adults = await currentAdults(tx, familyId);
        const [personCapability] = await rows(tx, sql`select 1 from auth.oauth_client where client_id=${actor.clientId} and metadata->>'personProfiles'='true'`);
        return {
          family,
          adults,
          rosterVersion: rosterVersion(adults),
          canEditBundle: access.own.includes(familyId) && !!personCapability,

          // Return only current approved contact details, never another person's requests or login identity.
          members: await rows(
            tx,
            sql`select p.id,p.display_name as name,p.kind,m.relationship,
            case when p.kind='adult' then coalesce(pr.data->>'contactPhone','') else '' end as contact_phone,
            case when p.kind='adult' then coalesce(pr.data->>'contactEmail','') else '' end as contact_email
            from directory.family_memberships m join directory.people p on p.id=m.person_id
            left join directory.person_profiles pr on pr.person_id=p.id
            where m.family_id=${familyId} and ${activeMembership} and p.status='active'
            order by p.kind,p.display_name,m.relationship`,
          ),
          profile: profile ?? {
            revision: 0,
            data: { mailingAddress: "", contactPhone: "" },
          },
          canEdit: access.own.includes(familyId),
          canReview: access.reviewer && !access.own.includes(familyId) && (!current?.data?.baselineAdults || await independentOfAdults(tx, actor.personId, current.data.baselineAdults)),
          openRequest: visibleOpen,
          hasOpenRequest: !!current,
          revisions: revisions
            .filter(
              (r) => access.reviewer || canSeeHistory(r, access.membershipIds),
            )
            .map(({ viewer_membership_ids, ...r }) => r),
          submissions: visible.map(({ viewer_membership_ids, ...s }) => {
            const sent = events
              .filter(
                (e) => e.request_id === s.request_id && e.action === "submit",
              )
              .sort((a, b) => a.version - b.version);
            const start = sent[s.version - 1]?.version;
            const end = sent[s.version]?.version ?? Infinity;
            // A later draft withdrawal must not replace an earlier review decision.
            const decision = [...events].sort((a, b) => a.version - b.version).find(
              (e) =>
                e.request_id === s.request_id &&
                e.version >= start &&
                e.version < end &&
                ["approve", "reject", "return", "withdraw"].includes(e.action),
            );
            const outcomes: Record<string, string> = {
              approve: "approved",
              reject: "rejected",
              return: "returned",
              withdraw: "withdrawn",
            };
            return {
              ...s,
              requestStatus: s.status,
              status: decision ? outcomes[decision.action] : "pending",
            };
          }),
          events: events.filter(
            (e) =>
              access.reviewer ||
              visible.some(
                (s) =>
                  s.request_id === e.request_id &&
                  new Date(e.occurred_at) >= new Date(s.submitted_at),
              ),
          ),
        };
      });
    },
    async submitForm(actor: ProfileActor, familyId: string, id: string, input: unknown) {
      const x = familyFormInput.parse(input);
      return run(actor, async (tx, access) => {
        requireOwn(access.own, familyId);
        await requirePersonCapability(tx, actor);
        const [person] = await rows(tx, sql`select 1 from directory.people where id=${actor.personId} and kind='adult' and status='active'`);
        if (!person) throw new ProfileError(403, "只有現任成人家長或監護人可送出。");
        const [previous] = await rows(tx, sql`select * from directory.family_change_requests where id=${id} for update`);
        // Retries never create another submission or overwrite later edits.
        if (previous && previous.family_id !== familyId) throw new ProfileError(403, "申請不屬於此家庭。");
        if (previous && previous.status === 'pending' && previous.version === x.version + 1) {
          const [sent] = await rows(tx, sql`select data,reason,submitted_by from directory.family_request_submissions where request_id=${id} and version=${x.submissionVersion + 1}`);
          if (sent?.submitted_by === actor.personId && sent.reason === x.reason &&
            JSON.stringify(z.array(adultInput).parse(sent.data.adults)) === JSON.stringify(x.adults) && sent.data.mailingAddress === x.mailingAddress && sent.data.contactPhone === x.contactPhone && sent.data.rosterVersion === x.rosterVersion)
            return { id, status: 'pending' };
        }
        if (previous && (!['draft','returned'].includes(previous.status) || previous.version !== x.version || previous.submission_version !== x.submissionVersion))
          throw new ProfileError(409, "申請已更新或送出，請重新載入。");
        if (!previous && (x.version !== 0 || x.submissionVersion !== 0)) throw new ProfileError(409, "請重新載入申請。");
        if (!previous && (await rows(tx, sql`select 1 from directory.family_change_requests where family_id=${familyId} and status in ('draft','returned','pending')`)).length)
          throw new ProfileError(409, "此家庭已有進行中的申請，請重新載入。");
        await tx.execute(sql`insert into directory.family_profiles(family_id) values(${familyId}) on conflict do nothing`);
        const [profile] = await rows(tx, sql`select * from directory.family_profiles where family_id=${familyId} for update`);
        if (!profile || profile.revision !== x.baseRevision) throw new ProfileError(409, "正式資料已更新，請重新載入。");
        const baselineAdults = await validateAdults(tx, familyId, x);
        const unchangedAdults = x.adults.length === baselineAdults.length && x.adults.every(a => {
          const before = baselineAdults.find(b => b.id === a.id);
          return before && !a.removed && a.relationship === before.relationship && JSON.stringify(a.data) === JSON.stringify(before.data);
        });
        const household = householdData.parse({ mailingAddress: x.mailingAddress, contactPhone: x.contactPhone });
        if (unchangedAdults && JSON.stringify(household) === JSON.stringify(householdData.parse(profile.data))) throw new ProfileError(400, "資料沒有變更。");
        const data = { ...household, adults: x.adults, rosterVersion: x.rosterVersion, baselineAdults };
        if (!previous) await tx.execute(sql`insert into directory.family_change_requests(id,family_id,base_revision,data,created_by,version)
          values(${id},${familyId},${x.baseRevision},${JSON.stringify(data)}::jsonb,${actor.personId},0)`);
        const viewers = await memberships(tx, familyId);
        await tx.execute(sql`insert into directory.family_request_submissions(request_id,version,base_revision,schema_version,data,reason,submitted_by,viewer_membership_ids)
          values(${id},${x.submissionVersion + 1},${x.baseRevision},2,${JSON.stringify(data)}::jsonb,${x.reason},${actor.personId},${JSON.stringify(viewers)}::jsonb)`);
        await tx.execute(sql`update directory.family_change_requests set data=${JSON.stringify(data)}::jsonb,reason=${x.reason},base_revision=${x.baseRevision},status='pending',version=${x.version + 1},submission_version=${x.submissionVersion + 1},updated_at=now() where id=${id}`);
        await event(tx, actor, id, "submit", x.version, x.reason);
        return { id, status: 'pending' };
      });
    },
    async create(actor: ProfileActor, familyId: string, id: string) {
      return run(actor, async (tx, access) => {
        requireOwn(access.own, familyId);
        const [existing] = await rows(
          tx,
          sql`select * from directory.family_change_requests where id=${id}`,
        );
        if (existing) {
          if (
            existing.family_id !== familyId ||
            existing.created_by !== actor.personId
          )
            throw new ProfileError(409, "申請識別碼已使用。");
          return { id };
        }
        if (
          (
            await rows(
              tx,
              sql`select 1 from directory.family_change_requests where family_id=${familyId} and status in ('draft','pending','returned')`,
            )
          ).length
        )
          throw new ProfileError(409, "此家庭已有進行中的申請，請重新載入。");
        await tx.execute(
          sql`insert into directory.family_profiles(family_id) values(${familyId}) on conflict do nothing`,
        );
        const [p] = await rows(
          tx,
          sql`select * from directory.family_profiles where family_id=${familyId}`,
        );
        if (!p) throw new ProfileError(409, "請重新載入家庭資料。");
        await tx.execute(
          sql`insert into directory.family_change_requests(id,family_id,base_revision,data,created_by) values(${id},${familyId},${p.revision},${JSON.stringify(p.data)}::jsonb,${actor.personId})`,
        );
        await event(tx, actor, id, "created", 1);
        return { id };
      });
    },
    async save(actor: ProfileActor, id: string, input: unknown) {
      const x = saveInput.parse(input);
      return run(actor, async (tx, access) => {
        const r = await request(tx, id);
        requireOwn(access.own, r.family_id);
        if (
          !["draft", "returned"].includes(r.status) ||
          r.version !== x.version
        )
          throw new ProfileError(409, "申請已更新或送出，請重新載入。");
        const [p] = await rows(
          tx,
          sql`select revision from directory.family_profiles where family_id=${r.family_id}`,
        );
        if (!p) throw new ProfileError(409, "請重新載入家庭資料。");
        if (p.revision !== x.baseRevision)
          throw new ProfileError(409, "正式資料已更新，請重新載入並確認修改。");
        await tx.execute(
          sql`update directory.family_change_requests set data=${JSON.stringify(x.data)}::jsonb,reason=${x.reason},base_revision=${x.baseRevision},status='draft',version=version+1,updated_at=now() where id=${id}`,
        );
        await event(tx, actor, id, "saved", x.version);
        return { version: x.version + 1 };
      });
    },
    async action(
      actor: ProfileActor,
      id: string,
      action: "submit" | "approve" | "reject" | "return" | "withdraw",
      input: unknown,
    ) {
      const x = actionInput.parse(input);
      return run(actor, async (tx, access) => {
        const r = await request(tx, id);
        const reviewing = ["approve", "reject", "return"].includes(action);
        if (reviewing) {
          if (
            !access.reviewer ||
            access.own.includes(r.family_id) ||
            r.created_by === actor.personId
          )
            throw new ProfileError(403, "需要獨立的管理員或註冊組審核。");
          if (r.data?.baselineAdults && !(await independentOfAdults(tx, actor.personId, r.data.baselineAdults)))
            throw new ProfileError(403, "需要與受影響成人無家庭關係的獨立人員審核。");
          if (
            (
              await rows(
                tx,
                sql`select 1 from directory.family_request_events where request_id=${id} and actor_id=${actor.personId} and action in ('created','saved','submit')`,
              )
            ).length
          )
            throw new ProfileError(403, "不能審核自己送出的申請。");
        } else requireOwn(access.own, r.family_id);
        const [prior] = await rows(
          tx,
          sql`select reason from directory.family_request_events where request_id=${id} and action=${action} and version=${x.version} and actor_id=${actor.personId}`,
        );
        if (prior) {
          if (prior.reason !== x.reason)
            throw new ProfileError(409, "此操作已完成，不能變更決定內容。");
          return { id, status: r.status };
        }
        if (
          r.version !== x.version ||
          r.submission_version !== x.submissionVersion
        )
          throw new ProfileError(409, "申請已更新，請重新載入後再操作。");
        const [family] = await rows(
          tx,
          sql`select 1 from directory.families where id=${r.family_id} and status='active'`,
        );
        if (!family) throw new ProfileError(403, "此家庭已停用。");
        const [p] = await rows(
          tx,
          sql`select * from directory.family_profiles where family_id=${r.family_id} for update`,
        );
        if (!p) throw new ProfileError(409, "請重新載入家庭資料。");
        if (action === "submit") {
          if (r.status !== "draft")
            throw new ProfileError(409, "只有草稿可以送出。");
          const data = profileData.parse(r.data);
          if (!data.mailingAddress || !data.contactPhone)
            throw new ProfileError(400, "請填寫通訊地址與聯絡電話。");
          if (p.revision !== r.base_revision)
            throw new ProfileError(409, "正式資料已更新，請重新確認草稿。");
          if (
            JSON.stringify(data) === JSON.stringify(profileData.parse(p.data))
          )
            throw new ProfileError(400, "資料沒有變更。");
          const viewers = await memberships(tx, r.family_id);
          await tx.execute(
            sql`insert into directory.family_request_submissions(request_id,version,base_revision,data,reason,submitted_by,viewer_membership_ids) values(${id},${r.submission_version + 1},${r.base_revision},${JSON.stringify(data)}::jsonb,${r.reason},${actor.personId},${JSON.stringify(viewers)}::jsonb)`,
          );
          await tx.execute(
            sql`update directory.family_change_requests set status='pending',submission_version=submission_version+1,version=version+1,updated_at=now() where id=${id}`,
          );
        } else {
          if (
            action === "withdraw"
              ? !["draft", "pending", "returned"].includes(r.status)
              : r.status !== "pending"
          )
            throw new ProfileError(409, "此申請已處理。");
          if (["reject", "return"].includes(action) && !x.reason)
            throw new ProfileError(400, "請填寫原因，讓家長知道如何處理。");
          if (action === "approve") {
            if (p.revision !== r.base_revision)
              throw new ProfileError(
                409,
                "正式資料已更新，請退回家長重新確認。",
              );
            const [s] = await rows(
              tx,
              sql`select * from directory.family_request_submissions where request_id=${id} and version=${x.submissionVersion}`,
            );
            if (!s) throw new ProfileError(409, "找不到送審版本。");
            const data = profileData.parse({ mailingAddress: s.data.mailingAddress, contactPhone: s.data.contactPhone });
            let revisionData: Record<string, unknown> = data;
            // A removed/disabled submitting guardian cannot have their pending request approved.
            const [submitter] = await rows(
              tx,
              sql`select 1 from directory.family_memberships m join directory.people p on p.id=m.person_id where m.family_id=${r.family_id} and m.person_id=${s.submitted_by} and m.relationship in ('father','mother','guardian') and ${activeMembership} and p.status='active'`,
            );
            if (!submitter)
              throw new ProfileError(
                409,
                "送件人已不具家庭權限，請退回重新送件。",
              );
            if (s.schema_version === 2) {
              await requirePersonCapability(tx, actor);
              if (!(await loginAllowed(tx, config, s.submitted_by))) throw new ProfileError(409, "送件人已失去登入資格。");
              const submitted = familyFormInput.parse({ ...data, adults: s.data.adults, rosterVersion: s.data.rosterVersion, reason: s.reason,
                version: r.version, submissionVersion: s.version, baseRevision: s.base_revision });
              const baseline = await validateAdults(tx, r.family_id, submitted);
              if (!(await independentOfAdults(tx, actor.personId, baseline))) throw new ProfileError(403, "需由與家長無家庭關係的獨立人員審核。");
              // All writes below remain in this transaction, including later family/revision writes.
              const adults = await applyAdults(tx, r.family_id, id, s.version, s.submitted_by, actor.personId, submitted.adults, baseline);
              revisionData = { ...data, adults, baselineAdults: baseline };
            }
            await tx.execute(
              sql`update directory.family_profiles set data=${JSON.stringify(data)}::jsonb,revision=revision+1 where family_id=${r.family_id}`,
            );
            const viewers = s.schema_version === 2 ? s.viewer_membership_ids : await memberships(tx, r.family_id);
            await tx.execute(
              sql`insert into directory.family_profile_revisions(family_id,revision,data,request_id,submission_version,submitted_by,approved_by,viewer_membership_ids) values(${r.family_id},${p.revision + 1},${JSON.stringify(revisionData)}::jsonb,${id},${s.version},${s.submitted_by},${actor.personId},${JSON.stringify(viewers)}::jsonb)`,
            );
          }
          const status = {
            approve: "approved",
            reject: "rejected",
            return: "returned",
            withdraw: "withdrawn",
          }[action];
          await tx.execute(
            sql`update directory.family_change_requests set status=${status},version=version+1,updated_at=now() where id=${id}`,
          );
        }
        await event(tx, actor, id, action, x.version, x.reason);
        return { id, status: (await request(tx, id)).status };
      });
    },
  };
}
