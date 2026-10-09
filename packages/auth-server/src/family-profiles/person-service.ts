import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { loginAllowed } from "../login-policy.js";
import { actionInput } from "./service.js";
import {
  personProfileData,
  ensurePersonProfile,
  type ProfileConnection,
} from "./person-record.js";
import {
  ProfileError,
  profileAccess,
  rows,
  activeMembership,
  type ProfileActor,
} from "./shared.js";
const saveInput = z
  .object({
    version: z.number().int().positive(),
    baseRevision: z.number().int().nonnegative(),
    data: personProfileData,
    reason: z.string().trim().max(1000),
  })
  .strict();
export function personProfileService(db: Database, config: RuntimeConfig) {
  const run = profileAccess(db, config, "personProfiles");
  // Both people must be current adult guardians in the same active family.
  // Re-evaluate this condition inside the directory transaction for every operation.
  const editablePerson = (actorId: string) => sql`p.kind='adult' and p.status='active' and exists (select 1 from directory.people editor where editor.id=${actorId} and editor.kind='adult' and editor.status='active') and (
    p.id=${actorId} or exists (
      select 1 from directory.family_memberships m join directory.families f on f.id=m.family_id
      where m.person_id=p.id and m.relationship in ('father','mother','guardian') and ${activeMembership} and f.status='active'
      and m.family_id in (
        select m.family_id from directory.family_memberships m join directory.families f on f.id=m.family_id
        where m.person_id=${actorId} and m.relationship in ('father','mother','guardian') and ${activeMembership} and f.status='active'
      )
    )
  )`;
  async function canEditPerson(tx: ProfileConnection, actorId: string, personId: string) {
    return (await rows(tx, sql`select 1 from directory.people p where p.id=${personId} and ${editablePerson(actorId)}`)).length > 0;
  }
  async function requireEdit(tx: ProfileConnection, actor: ProfileActor, personId: string) {
    if (!(await canEditPerson(tx, actor.personId, personId)))
      throw new ProfileError(403, "您只能修改自己或同一家庭中現任家長與監護人的資料。");
  }
  const ownsRequest = (actor: ProfileActor, r: Record<string, any>) =>
    actor.personId === r.person_id || actor.personId === r.created_by;
  async function requireRequestEdit(tx: ProfileConnection, actor: ProfileActor, r: Record<string, any>) {
    await requireEdit(tx, actor, r.person_id);
    if (!ownsRequest(actor, r))
      throw new ProfileError(403, "此申請由其他人建立，請由申請人或資料本人處理。");
  }
  async function independentReviewer(tx: ProfileConnection, actor: ProfileActor, r: Record<string, any>) {
    if (actor.personId === r.person_id || actor.personId === r.created_by ||
      await canEditPerson(tx, actor.personId, r.person_id)) return false;
    return !(await rows(tx, sql`select 1 from directory.person_request_events where request_id=${r.id} and actor_id=${actor.personId} and action in ('created','saved','submit') limit 1`)).length;
  }
  async function request(tx: ProfileConnection, id: string) {
    const [r] = await rows(
      tx,
      sql`select * from directory.person_change_requests where id=${id} for update`,
    );
    if (!r) throw new ProfileError(404, "找不到申請。");
    return r;
  }
  async function event(
    tx: ProfileConnection,
    actor: ProfileActor,
    id: string,
    action: string,
    version: number,
    submissionVersion: number,
    reason = "",
  ) {
    await tx.execute(
      sql`insert into directory.person_request_events(request_id,action,version,submission_version,actor_id,reason) values(${id},${action},${version},${submissionVersion},${actor.personId},${reason})`,
    );
  }
  async function active(tx: ProfileConnection, personId: string) {
    const [p] = await rows(
      tx,
      sql`select id,display_name as name from directory.people where id=${personId} and kind='adult' and status='active'`,
    );
    if (!p) throw new ProfileError(404, "找不到有效的成人資料。");
    return p;
  }
  return {
    async home(actor: ProfileActor) {
      return run(actor, async (tx, access) => ({
        canReview: access.reviewer,
        people: await rows(
          tx,
          sql`select p.id,p.display_name as name,coalesce(pr.revision,0) as revision from directory.people p left join directory.person_profiles pr on pr.person_id=p.id where ${editablePerson(actor.personId)} order by p.display_name,p.id`,
        ),
        reviewPeople: access.reviewer
          ? await rows(
              tx,
              sql`select p.id,p.display_name as name,pr.revision from directory.people p join directory.person_profiles pr on pr.person_id=p.id where p.kind='adult' and p.status='active' order by p.display_name limit 200`,
            )
          : [],
        queue: access.reviewer
          ? await rows(
              tx,
              sql`select r.id,r.person_id,p.display_name as person_name,r.updated_at from directory.person_change_requests r join directory.people p on p.id=r.person_id where r.status='pending' and p.status='active' and p.kind='adult' order by r.updated_at limit 200`,
            )
          : [],
      }));
    },
    async profile(actor: ProfileActor, personId: string) {
      return run(actor, async (tx, access) => {
        const editable = await canEditPerson(tx, actor.personId, personId);
        if (!access.reviewer && !editable)
          throw new ProfileError(403, "您沒有此個人資料的存取權限。");
        const fullHistory = access.reviewer || actor.personId === personId;
        const person = await active(tx, personId);
        const profile = await ensurePersonProfile(tx, personId);
        const [openRequest] = await rows(
          tx,
          sql`select * from directory.person_change_requests where person_id=${personId} and status in ('draft','returned','pending')`,
        );
        const visibleRequest = openRequest && (fullHistory || ownsRequest(actor, openRequest)) ? openRequest : null;
        // Co-parents see only requests they created, never another adult's private history.
        const revisions = fullHistory ? await rows(
          tx,
          sql`select r.*,a.display_name as approved_name,s.display_name as submitted_name from directory.person_profile_revisions r left join directory.people a on a.id=r.approved_by left join directory.people s on s.id=r.submitted_by where r.person_id=${personId} order by r.revision desc`,
        ) : [];
        const events = await rows(
          tx,
          sql`select e.*,p.display_name as actor_name from directory.person_request_events e join directory.person_change_requests r on r.id=e.request_id join directory.people p on p.id=e.actor_id where r.person_id=${personId} and (${fullHistory} or r.created_by=${actor.personId}) order by e.occurred_at desc,e.version desc`,
        );
        const submissions = await rows(
          tx,
          sql`select s.* from directory.person_request_submissions s join directory.person_change_requests r on r.id=s.request_id where r.person_id=${personId} and (${fullHistory} or r.created_by=${actor.personId}) order by s.submitted_at desc`,
        );
        const outcomes: Record<string, string> = {
          approve: "approved",
          reject: "rejected",
          return: "returned",
          withdraw: "withdrawn",
        };
        return {
          person,
          profile,
          canEdit: editable && (!openRequest || ownsRequest(actor, openRequest)),
          canReview: access.reviewer && !!openRequest && await independentReviewer(tx, actor, openRequest),
          isOwnProfile: actor.personId === personId,
          fullHistory,
          hasOpenRequest: !!openRequest,
          openRequest: visibleRequest ?? null,
          revisions,
          events,
          submissions: submissions.map((s) => {
            // A later draft withdrawal must not replace an earlier review decision.
            const decision = [...events].sort((a, b) => a.version - b.version).find(
              (e) =>
                e.request_id === s.request_id &&
                e.submission_version === s.version &&
                outcomes[e.action],
            );
            return {
              ...s,
              status: decision ? outcomes[decision.action] : "pending",
            };
          }),
        };
      });
    },
    async create(actor: ProfileActor, personId: string, id: string, initial?: unknown) {
      const draft = initial === undefined ? undefined : saveInput.omit({ version: true }).parse(initial);
      return run(actor, async (tx) => {
        await requireEdit(tx, actor, personId);
        await active(tx, personId);
        const [existing] = await rows(
          tx,
          sql`select person_id,created_by from directory.person_change_requests where id=${id}`,
        );
        if (existing) {
          if (
            existing.person_id !== personId ||
            existing.created_by !== actor.personId
          )
            throw new ProfileError(409, "申請識別碼已使用。");
          return { id };
        }
        if (
          (
            await rows(
              tx,
              sql`select 1 from directory.person_change_requests where person_id=${personId} and status in ('draft','pending','returned')`,
            )
          ).length
        )
          throw new ProfileError(
            409,
            "此人已有進行中的個人資料申請，請待處理完成後再申請。",
          );
        const p = await ensurePersonProfile(tx, personId);
        if (draft && draft.baseRevision !== p.revision)
          throw new ProfileError(409, "正式資料已更新，請重新載入確認。");
        await tx.execute(
          sql`insert into directory.person_change_requests(id,person_id,base_revision,data,reason,created_by) values(${id},${personId},${p.revision},${JSON.stringify(draft?.data ?? p.data)}::jsonb,${draft?.reason ?? ""},${actor.personId})`,
        );
        await event(tx, actor, id, "created", 1, 0);
        return { id };
      });
    },
    async save(actor: ProfileActor, id: string, input: unknown) {
      const x = saveInput.parse(input);
      return run(actor, async (tx) => {
        const r = await request(tx, id);
        await requireRequestEdit(tx, actor, r);
        if (
          !["draft", "returned"].includes(r.status) ||
          r.version !== x.version
        )
          throw new ProfileError(409, "申請已更新或送出，請重新載入。");
        const p = await ensurePersonProfile(tx, r.person_id);
        if (p.revision !== x.baseRevision)
          throw new ProfileError(409, "正式資料已更新，請重新載入確認。");
        await tx.execute(
          sql`update directory.person_change_requests set data=${JSON.stringify(x.data)}::jsonb,reason=${x.reason},base_revision=${x.baseRevision},status='draft',version=version+1,updated_at=now() where id=${id}`,
        );
        await event(tx, actor, id, "saved", x.version, r.submission_version);
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
        const r = await request(tx, id),
          reviewing = ["approve", "reject", "return"].includes(action);
        if (reviewing) {
          if (!access.reviewer || !(await independentReviewer(tx, actor, r)))
            throw new ProfileError(403, "需要未參與申請、且不屬於同一家庭的管理員或註冊組人員審核。");
        } else await requireRequestEdit(tx, actor, r);
        const [prior] = await rows(
          tx,
          sql`select reason,submission_version from directory.person_request_events where request_id=${id} and action=${action} and version=${x.version} and actor_id=${actor.personId}`,
        );
        if (prior) {
          if (
            prior.reason !== x.reason ||
            prior.submission_version !==
              (action === "submit"
                ? x.submissionVersion + 1
                : x.submissionVersion)
          )
            throw new ProfileError(409, "此操作已完成，不能變更決定內容。");
          return { id, status: r.status };
        }
        if (
          r.version !== x.version ||
          r.submission_version !== x.submissionVersion
        )
          throw new ProfileError(409, "申請已更新，請重新載入後再操作。");
        if (action === "submit" || action === "approve")
          await active(tx, r.person_id);
        if (action === "submit") {
          if (r.status !== "draft")
            throw new ProfileError(409, "只有草稿可以送出。");
          const p = await ensurePersonProfile(tx, r.person_id),
            data = personProfileData.parse(r.data);
          if (p.revision !== r.base_revision)
            throw new ProfileError(409, "正式資料已更新，請重新確認草稿。");
          if (
            Object.entries(data).every(
              ([key, value]) => p.data[key as keyof typeof data] === value,
            )
          )
            throw new ProfileError(400, "資料沒有變更。");
          await tx.execute(
            sql`insert into directory.person_request_submissions(request_id,version,base_revision,data,reason,submitted_by) values(${id},${r.submission_version + 1},${r.base_revision},${JSON.stringify(data)}::jsonb,${r.reason},${actor.personId})`,
          );
          await tx.execute(
            sql`update directory.person_change_requests set status='pending',submission_version=submission_version+1,version=version+1,updated_at=now() where id=${id}`,
          );
        } else {
          if (
            action === "withdraw"
              ? !["draft", "pending", "returned"].includes(r.status)
              : r.status !== "pending"
          )
            throw new ProfileError(409, "此申請已處理。");
          if (["reject", "return"].includes(action) && !x.reason)
            throw new ProfileError(400, "請填寫退回或不核准的原因。");
          if (action === "approve") {
            const p = await ensurePersonProfile(tx, r.person_id);
            if (p.revision !== r.base_revision)
              throw new ProfileError(409, "正式資料已更新，請退回重新確認。");
            const [s] = await rows(
              tx,
              sql`select * from directory.person_request_submissions where request_id=${id} and version=${x.submissionVersion}`,
            );
            if (!s) throw new ProfileError(409, "找不到送審版本。");
            // A target adult need not have a login account. The actual submitter
            // must remain admitted and authorised to edit that person's profile.
            if (!(await loginAllowed(tx, config, s.submitted_by)) ||
              !(await canEditPerson(tx, s.submitted_by, r.person_id)))
              throw new ProfileError(409, "送件人已失去資料修改資格，請退回重新確認。");
            const data = personProfileData.parse(s.data);
            await tx.execute(
              sql`update directory.person_profiles set revision=revision+1,data=${JSON.stringify(data)}::jsonb where person_id=${r.person_id}`,
            );
            await tx.execute(
              sql`update directory.people set display_name=${data.displayName},updated_at=now() where id=${r.person_id}`,
            );
            await tx.execute(
              sql`update auth."user" set name=${data.displayName},updated_at=now() where id=${r.person_id}::text`,
            );
            await tx.execute(
              sql`insert into directory.person_profile_revisions(person_id,revision,data,source,request_id,submission_version,submitted_by,approved_by) values(${r.person_id},${p.revision + 1},${JSON.stringify(data)}::jsonb,'request',${id},${s.version},${s.submitted_by},${actor.personId})`,
            );
          }
          const status = {
            approve: "approved",
            reject: "rejected",
            return: "returned",
            withdraw: "withdrawn",
          }[action];
          await tx.execute(
            sql`update directory.person_change_requests set status=${status},version=version+1,updated_at=now() where id=${id}`,
          );
        }
        await event(
          tx,
          actor,
          id,
          action,
          x.version,
          action === "submit" ? x.submissionVersion + 1 : x.submissionVersion,
          x.reason,
        );
        return { id, status: (await request(tx, id)).status };
      });
    },
  };
}
