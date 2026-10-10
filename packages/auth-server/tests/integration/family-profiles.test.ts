import { relationshipInput, relationshipService } from "../../src/admin/relationships.js";
import { createApp } from "../../src/app.js";
import { createAuth } from "../../src/auth-factory.js";
import { profilePortal } from "../../src/family-profiles/portal.js";
import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "../../src/db/database.js";
import { parseRuntimeConfig } from "../../src/runtime-config.js";
import {
  familyProfileService,
  type ProfileActor,
} from "../../src/family-profiles/service.js";
import { personProfileService } from "../../src/family-profiles/person-service.js";
import { recordAdministrativeName } from "../../src/family-profiles/person-record.js";
import { familyProfileRoutes } from "../../src/family-profiles/routes.js";
const enabled = process.env.RUN_FAMILY_PROFILE_TESTS === "true";
const url = new URL(
  enabled
    ? process.env.DATABASE_URL!
    : "postgres://localhost/smz_family_profiles_test",
);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== "/smz_family_profiles_test"
)
  throw new Error("Dedicated local smz_family_profiles_test database required");
const { db, pool, close } = createDatabase(url.href);
const config = parseRuntimeConfig({ DATABASE_URL: url.href, NODE_ENV: "test" });
const service = familyProfileService(db, config);
const persons = personProfileService(db, config);
let admin: ProfileActor,
  parent: ProfileActor,
  guardian: ProfileActor,
  outsider: ProfileActor,
  teacher: ProfileActor;
let family: string;
const data = {
  mailingAddress: "測試市森林路 10 號",
  contactPhone: "0912345678",
};
async function actor(role: string) {
  const personId = randomUUID(),
    sessionId = randomUUID(),
    email = `${personId}@example.test`;
  await pool.query(
    "insert into directory.people(id,kind,display_name,normalized_login_email) values($1,'adult',$2,$3)",
    [personId, role, email],
  );
  await pool.query(
    'insert into auth."user"(id,name,email,email_verified) values($1,$2,$3,true)',
    [personId, role, email],
  );
  await pool.query(
    "insert into directory.person_roles(person_id,role) values($1,$2)",
    [personId, role],
  );
  await pool.query(
    "insert into directory.login_invitations(id,person_id,normalized_email,status) values($1,$2,$3,'activated')",
    [randomUUID(), personId, email],
  );
  await pool.query(
    "insert into auth.session(id,user_id,token,expires_at,updated_at) values($1,$2,$1,now()+interval '1 day',now())",
    [sessionId, personId],
  );
  return { personId, sessionId, clientId: "profile-test" };
}
async function link(a: ProfileActor) {
  await pool.query(
    "insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'guardian')",
    [randomUUID(), a.personId, family],
  );
}
async function pending(a = parent, value = data) {
  const id = randomUUID();
  await service.create(a, family, id);
  const p = await service.profile(a, family);
  await service.save(a, id, {
    version: 1,
    baseRevision: p.profile.revision,
    data: { ...value, contactPhone: `(${value.contactPhone.slice(0, 2)}) ${value.contactPhone.slice(2)}` },
    reason: "聯絡資料更新",
  });
  await service.action(a, id, "submit", { version: 2, submissionVersion: 0 });
  return id;
}
const decision = () => ({ version: 3, submissionVersion: 1, reason: "已確認" });
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});
beforeEach(async () => {
  await pool.query(
    'truncate directory.people, directory.families, auth."user", auth.oauth_client cascade',
  );
  await pool.query(
    "insert into auth.oauth_client(id,client_id,public,disabled,redirect_uris,metadata) values('profile-test','profile-test',false,false,'{}','{\"familyProfiles\":true,\"personProfiles\":true}')",
  );
  await pool.query(
    "insert into directory.applications(client_id,display_name) values('profile-test','Profile Test')",
  );
  admin = await actor("admin");
  parent = await actor("parent");
  guardian = await actor("parent");
  outsider = await actor("parent");
  teacher = await actor("teacher");
  family = randomUUID();
  await pool.query(
    "insert into directory.families(id,code,display_name) values($1::uuid,$1::text,'測試家庭')",
    [family],
  );
  await link(parent);
  await link(guardian);
});
afterAll(close);
describe.runIf(enabled)("family profile approval", () => {
  it("keeps initial and later proposals separate and records one revision per approval", async () => {
    const id = await pending();
    expect((await service.profile(parent, family)).profile.revision).toBe(0);
    expect((await service.profile(guardian, family)).openRequest?.data).toEqual(
      data,
    );
    await service.action(admin, id, "approve", decision());
    await service.action(admin, id, "approve", decision());
    let result = await service.profile(parent, family);
    expect(result.profile).toMatchObject({ revision: 1, data });
    expect(result.revisions).toHaveLength(1);
    expect(
      (await service.home(admin)).reviewFamilies.some((f) => f.id === family),
    ).toBe(true);
    const next = await pending(guardian, {
      ...data,
      contactPhone: "0988-111-222",
    });
    expect((await service.profile(parent, family)).profile.data).toEqual(data);
    await service.action(admin, next, "approve", decision());
    result = await service.profile(parent, family);
    expect(result.revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(result.revisions[1]?.data).toEqual(data);
    expect(result.revisions[0]?.submitted_by).toBe(guardian.personId);
  });
  it("protects drafts against concurrent edits and freezes submitted versions", async () => {
    const id = randomUUID();
    await service.create(parent, family, id);
    const saves = await Promise.allSettled(
      [parent, guardian].map((a) =>
        service.save(a, id, { version: 1, baseRevision: 0, data, reason: "" }),
      ),
    );
    expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await service.action(parent, id, "submit", {
      version: 2,
      submissionVersion: 0,
    });
    await service.action(parent, id, "submit", {
      version: 2,
      submissionVersion: 0,
    });
    await expect(
      service.save(guardian, id, {
        version: 3,
        baseRevision: 0,
        data,
        reason: "",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.profile(parent, family)).submissions).toHaveLength(1);
    await expect(
      service.create(guardian, family, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("preserves rejected and returned submissions without changing approved data", async () => {
    const id = await pending();
    await expect(
      service.action(admin, id, "return", { ...decision(), reason: "" }),
    ).rejects.toMatchObject({ status: 400 });
    await service.action(admin, id, "return", decision());
    await service.save(parent, id, {
      version: 4,
      baseRevision: 0,
      data: { ...data, mailingAddress: "更正地址" },
      reason: "更正",
    });
    await service.action(parent, id, "submit", {
      version: 5,
      submissionVersion: 1,
    });
    await expect(
      service.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 409 });
    await service.action(admin, id, "reject", {
      version: 6,
      submissionVersion: 2,
      reason: "請再次確認",
    });
    const result = await service.profile(parent, family);
    expect(result.profile.revision).toBe(0);
    expect(result.revisions).toHaveLength(0);
    expect(result.submissions).toHaveLength(2);
    expect(result.submissions[1]?.data).toEqual(data);
    expect(result.submissions.map((s) => s.status)).toEqual([
      "rejected",
      "returned",
    ]);
    expect(result.events.some((e) => e.reason === "請再次確認")).toBe(true);
  });
  it.each([false, true])("preserves a returned family submission after withdrawal (save first: %s)", async (saveFirst) => {
    const id = await pending();
    await service.action(admin, id, "return", decision());
    if (saveFirst) await service.save(parent, id, {
      version: 4, baseRevision: 0, data: { ...data, mailingAddress: "未送出的修訂" }, reason: "修訂",
    });
    await service.action(parent, id, "withdraw", { version: saveFirst ? 5 : 4, submissionVersion: 1 });
    const p = await service.profile(parent, family);
    expect(p.submissions).toHaveLength(1);
    expect(p.submissions[0]).toMatchObject({ status: "returned", data });
    expect(p.events.some((e) => e.action === "withdraw")).toBe(true);
    expect(p.profile.revision).toBe(0);
  });
  it("denies outsiders, teachers, revoked registrars, self-approval and untrusted clients", async () => {
    const id = await pending();
    await expect(service.profile(outsider, family)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.action(teacher, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query(
      "insert into directory.family_profile_reviewers(person_id,granted_by) values($1,$2)",
      [teacher.personId, admin.personId],
    );
    expect((await service.home(teacher)).canReview).toBe(true);
    await pool.query(
      "delete from directory.family_profile_reviewers where person_id=$1",
      [teacher.personId],
    );
    await expect(
      service.action(teacher, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 403 });
    await link(admin);
    await expect(
      service.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query("update auth.oauth_client set metadata='{}'");
    await expect(service.home(parent)).rejects.toMatchObject({ status: 403 });
  });
  it("allows appointed non-admin registrar review", async () => {
    const id = await pending();
    await pool.query(
      "insert into directory.family_profile_reviewers(person_id,granted_by) values($1,$2)",
      [teacher.personId, admin.personId],
    );
    await service.action(teacher, id, "approve", decision());
    expect(
      (await service.profile(parent, family)).revisions[0]?.approved_by,
    ).toBe(teacher.personId);
  });
  it("fails closed on removed guardians, disabled users, expired sessions and inactive families", async () => {
    const id = await pending();
    await pool.query(
      "update directory.family_memberships set status='inactive' where person_id=$1",
      [parent.personId],
    );
    await expect(service.profile(parent, family)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "update directory.people set status='disabled' where id=$1",
      [admin.personId],
    );
    await expect(service.home(admin)).rejects.toMatchObject({ status: 403 });
    await pool.query("delete from auth.session where id=$1", [
      guardian.sessionId,
    ]);
    await expect(service.home(guardian)).rejects.toMatchObject({ status: 403 });
  });
  it("does not disclose old history or pending content to a newly linked guardian", async () => {
    const id = await pending();
    await service.action(admin, id, "approve", decision());
    await pending(parent, { ...data, contactPhone: "02-88889999" });
    await link(outsider);
    const result = await service.profile(outsider, family);
    expect(result.profile.revision).toBe(1);
    expect(result.revisions).toHaveLength(0);
    expect(result.submissions).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.openRequest).toBeNull();
    expect(result.hasOpenRequest).toBe(true);
  });
  it("serializes approve versus withdrawal and rolls back a failed revision insert", async () => {
    const id = await pending();
    const results = await Promise.allSettled([
      service.action(admin, id, "approve", decision()),
      service.action(parent, id, "withdraw", { ...decision(), reason: "" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const result = await service.profile(parent, family);
    expect(result.revisions.length).toBe(result.profile.revision);
    const other = await pending(parent, {
      ...data,
      contactPhone: "02-12345678",
    });
    await pool.query(
      "create function directory.test_profile_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$",
    );
    await pool.query(
      "create trigger test_profile_failure before insert on directory.family_profile_revisions for each row execute function directory.test_profile_failure()",
    );
    try {
      await expect(
        service.action(admin, other, "approve", decision()),
      ).rejects.toThrow();
      expect((await service.profile(parent, family)).profile.revision).toBe(
        result.profile.revision,
      );
      expect((await service.profile(parent, family)).openRequest?.status).toBe(
        "pending",
      );
    } finally {
      await pool.query(
        "drop trigger test_profile_failure on directory.family_profile_revisions; drop function directory.test_profile_failure()",
      );
    }
  });
  it("rejects stale base revisions and extra fields; validates API paths and JSON", async () => {
    const id = await pending();
    await pool.query(
      "update directory.family_profiles set revision=revision+1 where family_id=$1",
      [family],
    );
    await expect(
      service.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 409 });
    const app = familyProfileRoutes(service, async () => parent);
    expect((await app.request("/families/not-uuid")).status).toBe(400);
    expect(
      (
        await app.request(`/requests/${id}/save`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 3,
            baseRevision: 1,
            data: { ...data, role: "admin" },
            reason: "",
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/requests/${id}/approve`, {
          method: "POST",
          body: JSON.stringify(decision()),
        })
      ).status,
    ).toBe(403);
  });
});

const personal = {
  displayName: "更新家長",
  contactPhone: "0912000123",
  contactEmail: "contact@example.test",
};
async function pendingPerson(a = parent, personId = a.personId) {
  const id = randomUUID();
  await persons.create(a, personId, id);
  const p = await persons.profile(a, personId);
  await persons.save(a, id, {
    version: 1,
    baseRevision: p.profile.revision,
    data: { ...personal, contactPhone: "(0912) 000-123" },
    reason: "更新個人資料",
  });
  await persons.action(a, id, "submit", { version: 2, submissionVersion: 0 });
  return id;
}
describe.runIf(enabled)("personal profile approval", () => {
  it("keeps canonical names unchanged until approval and retains baseline and revisions", async () => {
    const id = await pendingPerson();
    expect(
      (
        await pool.query('select name,email from auth."user" where id=$1', [
          parent.personId,
        ])
      ).rows[0].name,
    ).toBe("parent");
    await persons.action(admin, id, "approve", decision());
    await persons.action(admin, id, "approve", decision());
    const p = await persons.profile(parent, parent.personId);
    expect(p.profile).toMatchObject({ revision: 1, data: personal });
    expect(p.revisions.map((r) => r.revision)).toEqual([1, 0]);
    expect(p.revisions[1].data.displayName).toBe("parent");
    const user = (
      await pool.query('select name,email from auth."user" where id=$1', [
        parent.personId,
      ])
    ).rows[0];
    expect(user.name).toBe(personal.displayName);
    expect(user.email).toBe(`${parent.personId}@example.test`);
    expect((await service.profile(parent, family)).profile.revision).toBe(0);
  });
  it("hides another guardian request and prohibits self approval", async () => {
    const id = await pendingPerson();
    expect(await persons.profile(guardian, parent.personId)).toMatchObject({
      openRequest: null, hasOpenRequest: true, canEdit: false,
      revisions: [], events: [], submissions: [],
    });
    await expect(
      persons.create(guardian, parent.personId, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      persons.action(guardian, id, "withdraw", decision()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      persons.action(teacher, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 403 });
    const own = await pendingPerson(admin);
    await expect(
      persons.action(admin, own, "approve", decision()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("tracks returned and rejected immutable submitted versions", async () => {
    const id = await pendingPerson();
    await persons.action(admin, id, "return", decision());
    await persons.save(parent, id, {
      version: 4,
      baseRevision: 0,
      data: { ...personal, contactPhone: "0988-000-123" },
      reason: "更正",
    });
    await persons.action(parent, id, "submit", {
      version: 5,
      submissionVersion: 1,
    });
    await expect(
      persons.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 409 });
    await persons.action(admin, id, "reject", {
      version: 6,
      submissionVersion: 2,
      reason: "確認資料",
    });
    const p = await persons.profile(parent, parent.personId);
    expect(p.submissions.map((s) => s.status)).toEqual([
      "rejected",
      "returned",
    ]);
    expect(p.profile.revision).toBe(0);
  });
  it.each([false, true])("preserves a returned personal submission after withdrawal (save first: %s)", async (saveFirst) => {
    const id = await pendingPerson();
    await persons.action(admin, id, "return", decision());
    if (saveFirst) await persons.save(parent, id, {
      version: 4, baseRevision: 0, data: { ...personal, displayName: "未送出的姓名" }, reason: "修訂",
    });
    await persons.action(parent, id, "withdraw", { version: saveFirst ? 5 : 4, submissionVersion: 1 });
    const p = await persons.profile(parent, parent.personId);
    expect(p.submissions).toHaveLength(1);
    expect(p.submissions[0]).toMatchObject({ status: "returned", data: personal });
    expect(p.events.some((e) => e.action === "withdraw")).toBe(true);
    expect(p.profile.revision).toBe(0);
  });
  it("rejects stale approvals after an administrative name revision", async () => {
    const id = await pendingPerson();
    await db.transaction(async (tx) => {
      await recordAdministrativeName(
        tx,
        parent.personId,
        admin.personId,
        "行政更正",
      );
      await tx.execute(
        sql`update directory.people set display_name='行政更正' where id=${parent.personId}`,
      );
      await tx.execute(
        sql`update auth."user" set name='行政更正' where id=${parent.personId}`,
      );
    });
    await expect(
      persons.action(admin, id, "approve", decision()),
    ).rejects.toMatchObject({ status: 409 });
    const p = await persons.profile(parent, parent.personId);
    expect(p.revisions[0].source).toBe("admin");
    expect(p.profile.data.displayName).toBe("行政更正");
  });
  it("requires independent client capability and rejects unapproved fields", async () => {
    const id = randomUUID();
    await persons.create(parent, parent.personId, id);
    await expect(
      persons.save(parent, id, {
        version: 1,
        baseRevision: 0,
        data: { ...personal, roles: ["admin"] },
        reason: "",
      }),
    ).rejects.toThrow();
    await expect(
      persons.save(parent, id, {
        version: 1,
        baseRevision: 0,
        data: { ...personal, contactEmail: "invalid" },
        reason: "",
      }),
    ).rejects.toThrow();
    await pool.query(
      `update auth.oauth_client set metadata='{"familyProfiles":true}'`,
    );
    await expect(persons.home(parent)).rejects.toMatchObject({ status: 403 });
    expect((await service.home(parent)).families).toHaveLength(1);
  });
});

describe.runIf(enabled)("same-family personal editing", () => {
  it("allows delegated proposals while preserving login and private history", async () => {
    const old = await pendingPerson(guardian);
    await persons.action(admin, old, "approve", decision());
    const id = await persons.create(parent, guardian.personId, randomUUID());
    await persons.save(parent, id.id, { version: 1, baseRevision: 1,
      data: { ...personal, displayName: "代家長更正" }, reason: "家長代填" });
    // The subject can continue a draft created by their co-parent.
    await persons.action(guardian, id.id, "submit", { version: 2, submissionVersion: 0 });
    const view = await persons.profile(parent, guardian.personId);
    expect(view.openRequest?.id).toBe(id.id);
    expect(view.revisions).toEqual([]);
    expect(view.submissions).toHaveLength(1);
    expect(view.events.every((e) => e.request_id === id.id)).toBe(true);
    expect(view.profile.data.displayName).toBe(personal.displayName);
    await persons.action(admin, id.id, "approve", decision());
    expect((await persons.profile(parent, guardian.personId)).profile.data.displayName).toBe("代家長更正");
    const user = (await pool.query('select name,email from auth."user" where id=$1', [guardian.personId])).rows[0];
    expect(user).toEqual({ name: "代家長更正", email: `${guardian.personId}@example.test` });
  });
  it("includes every direct parent or guardian, including adults without accounts, but excludes children and unrelated adults", async () => {
    const mother = randomUUID(), child = randomUUID();
    await pool.query("insert into directory.people(id,kind,display_name) values($1,'adult','媽媽'),($2,'student','孩子')", [mother, child]);
    await pool.query("insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'mother'),($4,$5,$3,'child')", [randomUUID(), mother, family, randomUUID(), child]);
    expect((await persons.home(parent)).people.map((p) => p.id).sort()).toEqual([parent.personId, guardian.personId, mother].sort());
    const id = await pendingPerson(parent, mother);
    await persons.action(admin, id, "approve", decision());
    expect((await persons.profile(parent, mother)).profile.data).toEqual(personal);
    expect((await pool.query('select id from auth."user" where id=$1', [mother])).rowCount).toBe(0);
    for (const target of [child, outsider.personId]) {
      await expect(persons.create(parent, target, randomUUID())).rejects.toMatchObject({ status: 403 });
    }
  });
  it.each(["expired", "future", "inactive", "family", "target", "actor"])("revokes delegated edits and approval when membership or eligibility changes: %s", async (change) => {
    const id = await pendingPerson(parent, guardian.personId);
    if (change === "expired") await pool.query("update directory.family_memberships set ends_on=current_date-1 where person_id=$1", [parent.personId]);
    if (change === "future") await pool.query("update directory.family_memberships set starts_on=current_date+1 where person_id=$1", [guardian.personId]);
    if (change === "inactive") await pool.query("update directory.family_memberships set status='inactive' where person_id=$1", [guardian.personId]);
    if (change === "family") await pool.query("update directory.families set status='disabled' where id=$1", [family]);
    if (change === "target") await pool.query("update directory.people set status='disabled' where id=$1", [guardian.personId]);
    if (change === "actor") await pool.query("update directory.people set status='disabled' where id=$1", [parent.personId]);
    await expect(persons.action(parent, id, "withdraw", decision())).rejects.toMatchObject({ status: 403 });
    await expect(persons.action(admin, id, "approve", decision())).rejects.toMatchObject({ status: change === "target" ? 404 : 409 });
    expect((await pool.query("select revision from directory.person_profiles where person_id=$1", [guardian.personId])).rows[0].revision).toBe(0);
  });
  it("denies same-family reviewers and prior participants even after leaving the family", async () => {
    await link(admin);
    const id = await pendingPerson(parent, guardian.personId);
    await expect(persons.action(admin, id, "approve", decision())).rejects.toMatchObject({ status: 403 });
    await pool.query("insert into directory.family_profile_reviewers(person_id,granted_by) values($1,$2)", [parent.personId, admin.personId]);
    await pool.query("update directory.family_memberships set status='inactive' where person_id=$1", [parent.personId]);
    await expect(persons.action(parent, id, "approve", decision())).rejects.toMatchObject({ status: 403 });
  });
});

async function familyForm() {
  const p = await service.profile(parent, family);
  return { version: 0, submissionVersion: 0, baseRevision: p.profile.revision, rosterVersion: p.rosterVersion,
    ...data, reason: "一次更新家庭", adults: p.adults.map(a => ({ id: a.id as string | null, relationship: a.relationship,
      removed: false, data: a.id === parent.personId ? personal : a.data })) };
}
describe.runIf(enabled)("unified family submission", () => {
  it("submits once and atomically edits household, adults, additions and removals after independent approval", async () => {
    const input = await familyForm(), id = randomUUID();
    input.adults.find(a => a.id === guardian.personId)!.removed = true;
    input.adults.push({ id: null, relationship: "mother", removed: false, data: { ...personal, displayName: "新增媽媽" } });
    await service.submitForm(parent, family, id, input);
    await service.submitForm(parent, family, id, input);
    let p = await service.profile(parent, family);
    expect(p.openRequest).toMatchObject({ status: "pending", version: 1, submission_version: 1 });
    expect(p.submissions).toHaveLength(1);
    expect(p.members).toHaveLength(2);
    expect(p.profile.revision).toBe(0);
    expect((await persons.profile(parent, parent.personId)).profile.revision).toBe(0);
    await expect(service.action(parent, id, "approve", {version:1,submissionVersion:1})).rejects.toMatchObject({status:403});
    await service.action(admin, id, "approve", {version:1,submissionVersion:1});
    p = await service.profile(parent, family);
    expect(p.profile.data).toEqual(data);
    expect(p.members.map(m => m.name).sort()).toEqual([personal.displayName,"新增媽媽"].sort());
    expect((await persons.profile(parent, parent.personId)).revisions[0]).toMatchObject({source:"family",family_request_id:id,data:personal});
    expect((await pool.query("select status from directory.family_memberships where person_id=$1",[guardian.personId])).rows[0].status).toBe("inactive");
    expect((await pool.query("select id from directory.people where id=$1",[guardian.personId])).rowCount).toBe(1);
    const mother = p.members.find(m=>m.name==='新增媽媽')!;
    expect((await pool.query('select id from auth."user" where id=$1',[mother.id])).rowCount).toBe(0);
    expect((await pool.query("select person_id from directory.login_invitations where person_id=$1",[mother.id])).rowCount).toBe(0);
    await expect(service.profile(guardian,family)).rejects.toMatchObject({status:403});
  });
  it("rejects all-adult removal, unrelated IDs, missing adults and stale rosters without any request", async () => {
    const original = await familyForm();
    const inputs = [
      {...original, adults: original.adults.map(a=>({...a,removed:true}))},
      {...original, adults: [...original.adults,{...original.adults[0],id:outsider.personId}]},
      {...original, adults: original.adults.slice(1)},
      {...original, rosterVersion:'0'.repeat(64)},
    ];
    for (const [index,input] of inputs.entries()) {
      const id = randomUUID();
      await expect(service.submitForm(parent,family,id,input)).rejects.toMatchObject({status:[400,403,403,409][index]});
      expect((await pool.query("select id from directory.family_change_requests where id=$1",[id])).rowCount).toBe(0);
    }
    await pool.query(`update auth.oauth_client set metadata='{"familyProfiles":true}'`);
    await expect(service.submitForm(parent,family,randomUUID(),original)).rejects.toMatchObject({status:403});
  });
  it("returns and resubmits the whole request directly with immutable previous submission", async () => {
    const input = await familyForm(), id = randomUUID();
    await service.submitForm(parent,family,id,input);
    await service.action(admin,id,"return",{version:1,submissionVersion:1,reason:"請修正"});
    await service.submitForm(parent,family,id,{...input,version:2,submissionVersion:1,mailingAddress:"新地址"});
    const p = await service.profile(parent,family);
    expect(p.openRequest).toMatchObject({status:"pending",version:3,submission_version:2});
    expect(p.submissions.map(s=>s.status)).toEqual(["pending","returned"]);
    expect(p.submissions[1].data.mailingAddress).toBe(data.mailingAddress);
    await expect(service.action(admin,id,"approve",{version:1,submissionVersion:1})).rejects.toMatchObject({status:409});
  });
  it("blocks stale combined approval after another personal revision", async () => {
    const id=randomUUID(); await service.submitForm(parent,family,id,await familyForm());
    await db.transaction(async tx => {
      await recordAdministrativeName(tx,parent.personId,admin.personId,"行政更新");
      await tx.execute(sql`update directory.people set display_name='行政更新' where id=${parent.personId}`);
    });
    await expect(service.action(admin,id,"approve",{version:1,submissionVersion:1})).rejects.toMatchObject({status:409});
    expect((await service.profile(parent,family)).profile.revision).toBe(0);
  });
  it("rolls back all adult and household writes if a later revision insert fails", async () => {
    const input=await familyForm(),id=randomUUID();
    input.adults.find(a=>a.id===guardian.personId)!.removed=true;
    input.adults.push({id:null,relationship:"guardian",removed:false,data:{...personal,displayName:"不可殘留"}});
    await service.submitForm(parent,family,id,input);
    await pool.query(`create function directory.fail_bundle_revision() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$`);
    await pool.query(`create trigger fail_bundle_revision before insert on directory.family_profile_revisions for each row execute function directory.fail_bundle_revision()`);
    try { await expect(service.action(admin,id,"approve",{version:1,submissionVersion:1})).rejects.toThrow(); }
    finally {
      await pool.query("drop trigger fail_bundle_revision on directory.family_profile_revisions");
      await pool.query("drop function directory.fail_bundle_revision()");
    }
    const p=await service.profile(parent,family);
    expect(p.profile.revision).toBe(0); expect(p.members).toHaveLength(2);
    expect(p.openRequest?.status).toBe("pending");
    expect((await persons.profile(parent,parent.personId)).profile.revision).toBe(0);
    expect((await pool.query("select id from directory.people where display_name='不可殘留'")).rowCount).toBe(0);
  });
  it("allows approved self-removal when another adult remains", async () => {
    const input=await familyForm(),id=randomUUID();
    input.adults.find(a=>a.id===parent.personId)!.removed=true;
    await service.submitForm(parent,family,id,input);
    await service.action(admin,id,"approve",{version:1,submissionVersion:1});
    await expect(service.profile(parent,family)).rejects.toMatchObject({status:403});
    expect((await service.profile(guardian,family)).members.map(m=>m.id)).toEqual([guardian.personId]);
  });
});

describe.runIf(enabled)("same-family member visibility", () => {
  it("shows current parents and children with approved contacts, excluding pending and login data", async () => {
    const child = randomUUID();
    await pool.query(
      "insert into directory.people(id,kind,display_name) values($1,'student','孩子測試')",
      [child],
    );
    await pool.query(
      "insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'child')",
      [randomUUID(), child, family],
    );
    const id = await pendingPerson(guardian);
    let result = await service.profile(parent, family);
    expect(result.members.map((m) => m.id).sort()).toEqual(
      [parent.personId, guardian.personId, child].sort(),
    );
    expect(
      result.members.find((m) => m.id === guardian.personId)?.contact_email,
    ).toBe("");
    await persons.action(admin, id, "approve", decision());
    result = await service.profile(parent, family);
    expect(
      result.members.find((m) => m.id === guardian.personId),
    ).toMatchObject({
      name: personal.displayName,
      contact_email: personal.contactEmail,
      contact_phone: personal.contactPhone,
    });
    expect(Object.keys(result.members[0]).sort()).toEqual(
      [
        "id",
        "name",
        "kind",
        "relationship",
        "contact_phone",
        "contact_email",
      ].sort(),
    );
    expect(await persons.profile(parent, guardian.personId)).toMatchObject({
      profile: { data: personal }, revisions: [], events: [], submissions: [], canEdit: true,
    });
    await expect(service.profile(outsider, family)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("excludes inactive, future and ended memberships and revokes access immediately", async () => {
    await pool.query(
      "update directory.family_memberships set starts_on=current_date+1 where person_id=$1",
      [guardian.personId],
    );
    expect((await service.profile(parent, family)).members).toHaveLength(1);
    await pool.query(
      "update directory.family_memberships set starts_on=null, ends_on=current_date-1 where person_id=$1",
      [guardian.personId],
    );
    expect((await service.profile(parent, family)).members).toHaveLength(1);
    await pool.query(
      "update directory.family_memberships set ends_on=null where person_id=$1",
      [guardian.personId],
    );
    await pool.query(
      "update directory.people set status='disabled' where id=$1",
      [guardian.personId],
    );
    expect((await service.profile(parent, family)).members).toHaveLength(1);
    await pool.query(
      "update directory.family_memberships set ends_on=current_date-1 where person_id=$1",
      [parent.personId],
    );
    await expect(service.profile(parent, family)).rejects.toMatchObject({
      status: 403,
    });
    expect((await service.home(parent)).families).toHaveLength(0);
  });
});

describe.runIf(enabled)("family membership history boundary", () => {
  it.each(['inactive', 'ended', 'scheduled'] as const)("creates a fresh membership when an %s guardian rejoins through directory administration", async state => {
    const first = await pending();
    await service.action(admin, first, 'approve', decision());
    const second = await pending(parent, { ...data, mailingAddress: '歷史申請私密地址' });
    expect((await service.profile(guardian, family)).openRequest?.id).toBe(second);
    const relationships = relationshipService(db, config);
    const original = (await relationships.snapshot()).familyLinks.find(m => m.personId === guardian.personId)!;
    const save = async (fields: Record<string, unknown>) => relationships.save(admin.personId, admin.sessionId,
      relationshipInput.parse({ kind: 'family-member', id: original.id, groupId: family, personId: guardian.personId,
        version: (await relationships.snapshot()).version, ...fields }));
    // Ordinary edits while access is continuous retain the history boundary.
    expect((await save({ status: 'active' })).id).toBe(original.id);
    const date = new Date(Date.now() + (state === 'ended' ? -1 : 1) * 86400_000).toISOString().slice(0, 10);
    await save(state === 'inactive' ? { status: 'inactive' } : state === 'ended' ? { endsOn: date } : { startsOn: date });
    await expect(service.profile(guardian, family)).rejects.toMatchObject({ status: 403 });
    const rejoined = await save({ status: 'active' });
    expect(rejoined.id).not.toBe(original.id);
    const links = (await relationships.snapshot()).familyLinks;
    expect(links.find(m => m.id === original.id)?.status).toBe('inactive');
    expect(links.find(m => m.id === rejoined.id)).toMatchObject({ personId: guardian.personId, familyId: family, status: 'active' });
    const view = await service.profile(guardian, family);
    expect(view.profile).toMatchObject({ revision: 1, data });
    expect(view.revisions).toHaveLength(0);
    expect(view.submissions).toHaveLength(0);
    expect(view.events).toHaveLength(0);
    expect(view.hasOpenRequest).toBe(true);
    expect(view.openRequest).toBeNull();
    expect((await service.profile(parent, family)).revisions).toHaveLength(1);
    expect((await service.profile(admin, family)).submissions).toHaveLength(2);
    // New submissions made after the rejoin become visible under the new ID.
    await service.action(parent, second, 'withdraw', decision());
    const fresh = await pending(parent, { ...data, mailingAddress: '重新加入後的新地址' });
    expect((await service.profile(guardian, family)).openRequest?.id).toBe(fresh);
  });
});

describe.runIf(enabled)("native Auth profile portal", () => {
  async function setupPortal(a = parent) {
    await pool.query(
      `insert into auth.oauth_client(id,client_id,public,disabled,redirect_uris,metadata) values('native','smz-profiles',false,false,'{}','{"familyProfiles":true,"personProfiles":true}') on conflict do nothing`,
    );
    await pool.query(
      "insert into directory.applications(client_id,display_name) values('smz-profiles','Native Profiles') on conflict do nothing",
    );
    const signature = createHmac("sha256", config.BETTER_AUTH_SECRET)
      .update(a.sessionId)
      .digest("base64");
    return {
      portal: profilePortal(db, config, createAuth(config, db)),
      headers: {
        cookie: `better-auth.session_token=${encodeURIComponent(`${a.sessionId}.${signature}`)}`,
        origin: new URL(config.AUTH_ISSUER).origin,
        "content-type": "application/x-www-form-urlencoded",
      },
    };
  }
  it("routes admins to administration and parents to their family from the profiles entry point", async () => {
    const app = createApp(config, db);
    const adminLogin = await setupPortal(admin);
    const parentLogin = await setupPortal(parent);
    expect(await (await app.request('/admin', { headers: adminLogin.headers })).text()).not.toContain('/admin/family-profile-settings');
    for (const method of ['GET', 'POST']) {
      expect((await app.request('/admin/family-profile-settings', {method, headers: adminLogin.headers})).status).toBe(404);
    }
    for (const [headers, destination] of [[adminLogin.headers, '/admin'], [parentLogin.headers, '/profiles/family']] as const) {
      for (const path of ['/profiles', '/profiles?code=callback-code&state=callback-state']) {
        const result = await app.request(path, { headers });
        expect(result.status).toBe(303);
        expect(result.headers.get('location')).toBe(destination);
      }
    }
    for (const path of ['/profiles/', '/profiles/family', '/profiles/person', `/profiles/family/${family}?edit=1`, `/profiles/person/${parent.personId}`, '/profiles/unknown/nested/path', '/profiles/signed-out']) {
      const result = await app.request(path, { headers: adminLogin.headers });
      expect(result.status).toBe(303);
      expect(result.headers.get('location')).toBe('/admin');
    }
    expect((await app.request(`/profiles/family/${family}`, { headers: parentLogin.headers })).status).toBe(200);
    const submission = await app.request(`/profiles/family/${family}/submit-all`, { method: 'POST', headers: adminLogin.headers });
    expect(submission.status).toBe(303);
    expect(submission.headers.get('location')).toBe('/admin');
    // Use current directory admission and roles rather than a cached session role.
    await pool.query("delete from directory.person_roles where person_id=$1 and role='admin'", [admin.personId]);
    expect((await app.request('/profiles', { headers: adminLogin.headers })).headers.get('location')).toBe('/profiles/family');
    await pool.query("insert into directory.person_roles(person_id,role) values($1,'admin')", [admin.personId]);
    await pool.query("update directory.people set status='disabled' where id=$1", [admin.personId]);
    expect((await app.request('/profiles', { headers: adminLogin.headers })).headers.get('location')).toBe('/profiles/family');
    await pool.query("delete from auth.session where id=$1", [admin.sessionId]);
    expect((await app.request('/profiles', { headers: adminLogin.headers })).headers.get('location')).toContain('/oauth2/authorize?');
  });
  it("keeps admin logout available instead of redirecting it to the panel", async () => {
    const { headers } = await setupPortal(admin);
    const app = createApp(config, db);
    const result = await app.request('/profiles/sign-out', { method: 'POST', headers });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/profiles/signed-out');
    expect((await pool.query('select id from auth.session where id=$1', [admin.sessionId])).rowCount).toBe(0);
    expect((await app.request('/profiles/signed-out', { headers })).status).toBe(200);
  });
  it.each([['family', 'approve'], ['family', 'return'], ['family', 'reject'], ['person', 'approve'], ['person', 'return'], ['person', 'reject']] as const)(
    "lets admins review %s requests with %s under the admin panel", async (kind, action) => {
      const { headers } = await setupPortal(admin);
      const app = createApp(config, db);
      // Auth admin review is independent of the parent portal's OAuth registration.
      await pool.query("delete from auth.oauth_client where client_id='smz-profiles'");
      const id = kind === 'family' ? randomUUID() : await pendingPerson();
      if (kind === 'family') await service.submitForm(parent, family, id, await familyForm());
      const target = kind === 'family' ? family : parent.personId;
      const path = `/admin/profile-reviews/${kind}/${target}`;
      const dashboard = await app.request('/admin', { headers });
      expect(await dashboard.text()).toContain('href="/admin/profile-reviews"');
      const queue = await app.request(`/admin/profile-reviews/${kind}`, { headers });
      expect(queue.status).toBe(200);
      expect(await queue.text()).toContain(`href="${path}"`);
      const details = await app.request(path, { headers });
      expect(details.status).toBe(200);
      const html = await details.text();
      expect(html).toContain(`action="${path}/${action}"`);
      expect(html).toContain('<aside class="sidebar">');
      expect(html).toContain('href="/admin/profile-reviews" aria-current="page"');
      expect(html).not.toContain('class="topbar"');
      expect(html).toContain('href="/admin/profile-reviews/person"');
      expect(html).not.toContain('action="/profiles/family/');
      expect(html).not.toContain('action="/profiles/person/');
      const body = new URLSearchParams({ requestId: id, version: kind === 'family' ? '1' : '3', submissionVersion: '1', reason: '已核對' });
      const blocked = await app.request(`${path}/${action}`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body });
      expect(blocked.status).toBe(403);
      const result = await app.request(`${path}/${action}`, { method: 'POST', headers, body });
      expect(result.status).toBe(303);
      expect(result.headers.get('location')).toBe(path);
      const state = kind === 'family' ? await service.profile(parent, family) : await persons.profile(parent, parent.personId);
      expect(state.profile.revision).toBe(action === 'approve' ? 1 : 0);
      expect(state.submissions[0]?.status).toBe(({ approve: 'approved', return: 'returned', reject: 'rejected' })[action]);
      expect((await app.request(path, { headers })).status).toBe(200);
    },
  );
  it("protects admin review routes against parents, revoked roles and self-review", async () => {
    const app = createApp(config, db);
    const adminLogin = await setupPortal(admin), parentLogin = await setupPortal(parent);
    const id = await pending();
    const path = `/admin/profile-reviews/family/${family}`;
    const body = new URLSearchParams({ requestId: id, version: '3', submissionVersion: '1' });
    for (const method of ['GET', 'POST']) {
      const response = await app.request(method === 'GET' ? path : `${path}/approve`, { method, headers: parentLogin.headers, ...(method === 'POST' ? { body } : {}) });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin');
    }
    await link(admin);
    expect((await app.request(`${path}/approve`, { method: 'POST', headers: adminLogin.headers, body })).status).toBe(403);
    expect((await service.profile(parent, family)).openRequest?.status).toBe('pending');
    await pool.query("update auth.oauth_client set metadata='{}' where client_id='smz-profiles'");
    expect((await app.request(path, { headers: adminLogin.headers })).status).toBe(200);
    await pool.query("delete from directory.person_roles where person_id=$1 and role='admin'", [admin.personId]);
    expect((await app.request(path, { headers: adminLogin.headers })).headers.get('location')).toBe('/admin');
  });
  it("rechecks admin authority in the service and keeps client API access separate", async () => {
    const native = familyProfileService(db, config, "administration");
    const id = await pending();
    await expect(native.home(parent)).rejects.toMatchObject({status:403});
    await pool.query("update auth.oauth_client set metadata='{}' where client_id='profile-test'");
    await expect(service.home(admin)).rejects.toMatchObject({status:403});
    expect((await native.home(admin)).canReview).toBe(true);
    await pool.query("delete from directory.person_roles where person_id=$1 and role='admin'",[admin.personId]);
    await expect(native.action(admin,id,"approve",decision())).rejects.toMatchObject({status:403});
    await pool.query("insert into directory.person_roles(person_id,role) values($1,'admin')",[admin.personId]);
    await pool.query("update directory.people set status='disabled' where id=$1",[admin.personId]);
    await expect(native.home(admin)).rejects.toMatchObject({status:403});
    await pool.query("update directory.people set status='active' where id=$1",[admin.personId]);
    await pool.query("delete from auth.session where id=$1",[admin.sessionId]);
    await expect(native.action(admin,id,"approve",decision())).rejects.toMatchObject({status:403});
    expect((await pool.query("select status from directory.family_change_requests where id=$1",[id])).rows[0].status).toBe('pending');
  });
  it("keeps admin review separate from personal editing", async () => {
    const {headers}=await setupPortal(admin);
    const app=createApp(config,db);
    const path=`/admin/profile-reviews/person/${admin.personId}`;
    const own=await app.request(path,{headers});
    expect(own.status).toBe(200);
    const html=await own.text();
    expect(html).toContain('<aside class="sidebar">');
    expect(html).not.toContain(`action="${path}/create"`);
    const list=await (await app.request('/admin/profile-reviews/person',{headers})).text();
    expect(list).not.toContain(`href="${path}"`);
    for(const action of ['create','save','submit','withdraw']) {
      expect((await app.request(`${path}/${action}`,{method:'POST',headers,body:new URLSearchParams({requestId:randomUUID()})})).status).toBe(403);
    }
    expect((await app.request(`/admin/profile-reviews/family/${family}/submit-all`,{method:'POST',headers})).status).toBe(403);
  });
  it("shows the live signed-in identity when viewing another parent, escaping account content", async () => {
    const { portal, headers } = await setupPortal();
    await pool.query("update directory.people set display_name=$1 where id=$2", ['登入家長 <script>alert(1)</script>', parent.personId]);
    const html = await (await portal.request(`/person/${guardian.personId}`, { headers })).text();
    const account = html.match(/<section class="signed-in-account"[\s\S]*?<\/section>/)?.[0];
    expect(account).toContain('登入家長 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(account).toContain(`${parent.personId}@example.test`);
    expect(account).not.toContain(`${guardian.personId}@example.test`);
    expect(account).toContain('method="post" action="/profiles/sign-out"');
  });
  it("requires same-origin POST logout and revokes the session even without profile access", async () => {
    const { headers } = await setupPortal();
    const app = createApp(config, db);
    const live = async () => (await pool.query('select id from auth.session where id=$1', [parent.sessionId])).rowCount;
    await app.request('/profiles/sign-out', { headers });
    expect(await live()).toBe(1);
    for (const origin of ['', 'https://untrusted.example']) {
      expect((await app.request('/profiles/sign-out', { method: 'POST', headers: { ...headers, origin } })).status).toBe(403);
      expect(await live()).toBe(1);
    }
    await pool.query("update auth.oauth_client set metadata='{}' where client_id='smz-profiles'");
    const denied = await app.request(`/profiles/family/${family}`, { headers });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('action="/profiles/sign-out"');
    const result = await app.request('/profiles/sign-out', { method: 'POST', headers });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/profiles/signed-out');
    expect(result.headers.get('set-cookie')).toMatch(/better-auth.session_token=;[^,]*Max-Age=0/i);
    expect(await live()).toBe(0);
    const landing = await app.request('/profiles/signed-out', { headers });
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('已登出');
    expect((await app.request(`/profiles/family/${family}`, { headers })).status).toBe(303);
    expect((await app.request(`/profiles/family/${family}/submit-all`, { method: 'POST', headers })).status).toBe(403);
    expect((await app.request('/profiles/sign-out', { method: 'POST', headers })).status).toBe(303);
  });
  it("renders own family and children, and enforces native client permissions", async () => {
    const { portal, headers } = await setupPortal();
    const res = await portal.request(`/family/${family}`, { headers });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("家長與監護人");
    expect(html).toContain(`href="/profiles/family/${family}?edit=1#family-details"`);
    expect(html).toContain('aria-label="目前家庭資料"');
    expect(html).not.toContain('id="family-form"');
    const coParentPage = await portal.request(`/person/${guardian.personId}`, { headers });
    expect(coParentPage.status).toBe(200);
    expect(await coParentPage.text()).toContain("您正在代同家庭的家長或監護人申請修改");
    expect(html).toContain('<html lang="zh-Hant">');
    expect(html).not.toContain('action="/admin/lang"');
    const fullPage = await createApp(config, db).request(`/profiles/family/${family}`, {headers});
    expect(fullPage.headers.get("referrer-policy")).toBe("same-origin");
    expect(
      (await portal.request(`/person/${outsider.personId}`, { headers }))
        .status,
    ).toBe(403);
    await pool.query(
      "update auth.oauth_client set metadata='{}' where client_id='smz-profiles'",
    );
    expect(
      (await portal.request(`/family/${family}`, { headers })).status,
    ).toBe(403);
  });
  it("saves and submits co-parent fields directly from the family form, retaining approval and redirect context", async () => {
    const { portal, headers } = await setupPortal();
    const html = await (await portal.request(`/family/${family}?edit=1`, { headers })).text();
    expect(html).toContain('class="family-details is-editing"');
    expect(html).toContain('aria-label="目前家庭資料"');
    expect(html).toContain('取消編輯');
    expect(html).toContain(`action="/profiles/family/${family}/submit-all"`);
    expect(html).not.toContain('儲存草稿');
    expect(html.match(/<form[^>]*id="family-form"[^>]*>[\s\S]*?<\/form>/)?.[0].match(/type="submit"/g)).toHaveLength(1);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const requestId = randomUUID();
    const initial = { familyId: family, inline: "1", requestId, baseRevision: "0", ...personal,
      contactPhone: "(0912) 000-123", reason: "家庭頁面代填" };
    const saved = await portal.request(`/person/${guardian.personId}/create`, {
      method: "POST", headers, body: new URLSearchParams(initial),
    });
    const location = `/profiles/family/${family}#parent-${guardian.personId}`;
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(location);
    expect((await persons.profile(parent, guardian.personId)).openRequest).toMatchObject({
      id: requestId, status: "draft", data: personal, reason: "家庭頁面代填", version: 1,
    });
    expect((await persons.profile(parent, guardian.personId)).profile.revision).toBe(0);
    const sent = await portal.request(`/person/${guardian.personId}/submit`, { method: "POST", headers,
      body: new URLSearchParams({ familyId: family, requestId, version: "1", submissionVersion: "0" }),
    });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(location);
    await persons.action(admin, requestId, "approve", { version: 2, submissionVersion: 1 });
    expect((await persons.profile(parent, guardian.personId)).profile).toMatchObject({ revision: 1, data: personal });
  });
  it("rejects stale or invalid inline drafts and cross-family targets without creating requests", async () => {
    const { portal, headers } = await setupPortal();
    for (const [personId, fields, status] of [
      [guardian.personId, { baseRevision: "99" }, 409],
      [guardian.personId, { contactEmail: "invalid" }, 400],
      [outsider.personId, {}, 403],
    ] as const) {
      const requestId = randomUUID();
      const response = await portal.request(`/person/${personId}/create`, { method: "POST", headers,
        body: new URLSearchParams({ ...personal, familyId: family, inline: "1", requestId, baseRevision: "0", ...fields }),
      });
      expect(response.status).toBe(status);
      expect((await pool.query("select id from directory.person_change_requests where id=$1", [requestId])).rowCount).toBe(0);
    }
    await pool.query(`update auth.oauth_client set metadata='{"familyProfiles":true}' where client_id='smz-profiles'`);
    const html = await (await portal.request(`/family/${family}`, { headers })).text();
    expect(html).not.toContain('name="displayName"');
    expect(html).toContain("目前無法編輯此人的個人資料");
    expect((await portal.request(`/person/${guardian.personId}/create`, { method: "POST", headers,
      body: new URLSearchParams({ ...personal, familyId: family, inline: "1", requestId: randomUUID(), baseRevision: "0" }),
    })).status).toBe(403);
  });
  it("accepts one native POST for household and all adult rows, with no draft step", async () => {
    const {portal,headers}=await setupPortal();
    const input=await familyForm(),requestId=randomUUID();
    const body=new URLSearchParams({requestId,version:'0',submissionVersion:'0',baseRevision:String(input.baseRevision),rosterVersion:input.rosterVersion,
      mailingAddress:input.mailingAddress,contactPhone:input.contactPhone,reason:input.reason});
    input.adults.forEach((a,i)=>Object.entries({id:a.id??'',relationship:a.relationship,removed:String(a.removed),...a.data}).forEach(([k,v])=>body.set(`adult-${i}-${k}`,v)));
    const response=await portal.request(`/family/${family}/submit-all`,{method:'POST',headers,body});
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/profiles/family/${family}`);
    expect((await service.profile(parent,family)).openRequest?.status).toBe('pending');
    const html=await (await portal.request(`/family/${family}`,{headers})).text();
    expect(html).toContain('整份家庭資料已送出'); expect(html).not.toContain('儲存草稿');
  });
  it("renders only current same-family children in the relationship graph", async () => {
    const { portal, headers } = await setupPortal();
    for (const [name, status] of [["可見孩子", "active"], ["已離開孩子", "inactive"]]) {
      const child = randomUUID();
      await pool.query("insert into directory.people(id,kind,display_name) values($1,'student',$2)", [child, name]);
      await pool.query("insert into directory.family_memberships(id,person_id,family_id,relationship,status) values($1,$2,$3,'child',$4)", [randomUUID(), child, family, status]);
    }
    const response = await portal.request(`/family/${family}`, {headers});
    const html = await response.text();
    const graph = html.match(/<section class="panel family-map"[\s\S]*?<\/section>/)?.[0];
    expect(response.status).toBe(200);
    expect(graph).toContain("家庭關係");
    expect(graph).toContain("可見孩子");
    expect(graph).not.toContain("已離開孩子");
    expect(graph).toContain("1 位孩子");
    expect(graph).not.toContain("href=");
    const stranger = await setupPortal(outsider);
    expect((await stranger.portal.request(`/family/${family}`, {headers: stranger.headers})).status).toBe(403);
  });
  it("initializes direct links without granting or restoring capabilities", async () => {
    const { portal, headers } = await setupPortal();
    await pool.query("delete from auth.oauth_client where client_id='smz-profiles'");
    expect((await portal.request(`/person/${parent.personId}`, { headers })).status).toBe(403);
    const client = await pool.query("select public, disabled, metadata from auth.oauth_client where client_id='smz-profiles'");
    expect(client.rows).toHaveLength(1);
    expect(client.rows[0]).toMatchObject({ public: false, disabled: false });
    expect(client.rows[0].metadata?.personProfiles).not.toBe(true);
    await pool.query(`update auth.oauth_client set metadata='{"personProfiles":true}' where client_id='smz-profiles'`);
    expect((await portal.request(`/person/${parent.personId}`, { headers })).status).toBe(200);
    expect((await portal.request(`/family/${family}`, { headers })).status).toBe(403);
    await pool.query("update auth.oauth_client set disabled=true where client_id='smz-profiles'");
    expect((await portal.request(`/person/${parent.personId}`, { headers })).status).toBe(403);
    expect((await pool.query("select disabled from auth.oauth_client where client_id='smz-profiles'")).rows[0].disabled).toBe(true);
  });
  it("requires same origin and a live session for mutations", async () => {
    const { portal, headers } = await setupPortal();
    const id = randomUUID(),
      body = new URLSearchParams({ requestId: id });
    expect(
      (
        await portal.request(`/person/${parent.personId}/create`, {
          method: "POST",
          headers: { ...headers, origin: "https://other.example" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await portal.request(`/person/${parent.personId}/create`, {
          method: "POST",
          headers,
          body,
        })
      ).status,
    ).toBe(303);
    expect(
      (await persons.profile(parent, parent.personId)).openRequest?.id,
    ).toBe(id);
    await pool.query("delete from auth.session where id=$1", [
      parent.sessionId,
    ]);
    expect(
      (
        await portal.request(`/person/${parent.personId}/create`, {
          method: "POST",
          headers,
          body,
        })
      ).status,
    ).toBe(403);
  });
});

describe.runIf(enabled)("phone formatting compatibility", () => {
  it.each(["family", "person"] as const)("does not submit punctuation-only changes to a legacy %s phone", async (kind) => {
    const target = kind === "family" ? service : persons;
    const subjectId = kind === "family" ? family : parent.personId;
    const approved = kind === "family" ? await pending() : await pendingPerson();
    await target.action(admin, approved, "approve", decision());
    const table = kind === "family" ? "family_profiles" : "person_profiles";
    const column = kind === "family" ? "family_id" : "person_id";
    const legacyPhone = kind === "family" ? "(0912) 345-678" : "(0912) 000-123";
    await pool.query(`update directory.${table} set data=jsonb_set(data,'{contactPhone}',$1::jsonb) where ${column}=$2`, [JSON.stringify(legacyPhone), subjectId]);
    const id = randomUUID();
    await target.create(parent, subjectId, id);
    await target.save(parent, id, { version: 1, baseRevision: 1, data: kind === "family" ? data : personal, reason: "" });
    await expect(target.action(parent, id, "submit", { version: 2, submissionVersion: 0 })).rejects.toMatchObject({status: 400, message: "資料沒有變更。"});
    const stored = await pool.query(`select revision,data from directory.${table} where ${column}=$1`, [subjectId]);
    expect(stored.rows[0]).toMatchObject({revision: 1, data: {contactPhone: legacyPhone}});
  });
});
