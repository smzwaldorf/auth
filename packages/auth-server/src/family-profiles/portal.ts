import { familyDetails, familyFormScript, adultSummary } from "./family-form.js";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import type { createAuth } from "../auth-factory.js";
import { hasLiveSession } from "../global-logout.js";
import { escape } from "../admin/views.js";
import { isAdmin } from "../admin/service.js";
import { ensureProfileClient, profileAuthorizationUrl } from "./sign-in.js";
import { familyProfileService } from "./service.js";
import { personProfileService } from "./person-service.js";
import { ProfileError, rows, type ProfileActor } from "./shared.js";

import { type SignedInAccount, page as renderPage, familyGraph, labels, displayValue, sameValue, fieldKeys, hidden, values, field, badge, timestamp } from "./views.js";

/** Native admin review uses Auth admin authorization; the parent portal retains client checks. */
export function profilePortal(
  db: Database,
  config: RuntimeConfig,
  auth: Pick<ReturnType<typeof createAuth>, "api">,
  options: { administration?: boolean } = {},
) {
  const app = new Hono<{ Variables: { actor: ProfileActor; nonce: string; account: SignedInAccount } }>();
  const basePath = options.administration ? "/admin/profile-reviews" : "/profiles";
  const page = (title: string, body: string, kind?: string, account?: SignedInAccount) => renderPage(title, body, kind, account, basePath);
  const services = {
    family: familyProfileService(db, config, options.administration ? "administration" : "client"),
    person: personProfileService(db, config, options.administration ? "administration" : "client"),
  };
  type ProfileView = Awaited<ReturnType<typeof services.family.profile>> | Awaited<ReturnType<typeof services.person.profile>>;
  function renderRequest(p: ProfileView, kind: "family" | "person", actionUrl: string, familyId?: string) {
    const r = p.openRequest;
    const prefix = familyId && "person" in p ? `parent-${p.person.id}-` : "";
    const form = (action: string, body: string) =>
      `<form method="post" action="${actionUrl}/${action}">${familyId ? hidden("familyId", familyId) : ""}${r ? hidden("requestId", r.id) + hidden("version", r.version) + hidden("submissionVersion", r.submission_version) : ""}${body}</form>`;
    let request = "";
    if (p.canEdit && !p.hasOpenRequest)
      request = `<section class="panel"><div class="panel-head"><h2>申請更新資料</h2></div><p class="request-intro">先填寫並儲存草稿，確認內容後再送出審核。核准前，正式資料會保持不變。</p>${form("create", hidden("requestId", crypto.randomUUID()) + '<div class="actions"><button>申請修改</button></div>')}</section>`;
    if (familyId && kind === "person" && p.canEdit && !p.hasOpenRequest)
      request = `<section class="panel"><p class="request-intro">修改此家長的資料後，先儲存草稿，再確認送出。</p>${form("create", hidden("requestId", crypto.randomUUID()) + hidden("baseRevision", p.profile.revision) + hidden("inline", "1") + `<div class="fields">${fieldKeys(kind).map(k => field(k, p.profile.data[k] ?? "", kind, prefix)).join("")}<div class="field"><label for="${prefix}request-reason">申請說明 <span class="required">選填</span></label><textarea id="${prefix}request-reason" name="reason" rows="2" maxlength="1000"></textarea></div></div><div class="actions"><button>儲存草稿</button></div>`)}</section>`;
    if (p.hasOpenRequest && !r)
      request = '<section class="panel"><h2>已有進行中的申請</h2><p class="empty">已有其他人建立申請，內容僅供申請人、資料本人及審核人員查看。請待處理完成後再申請，或聯絡學校。</p></section>';
    if (r) {
      const editable = p.canEdit && ["draft", "returned"].includes(r.status);
      request = `<section class="panel"><div class="panel-head"><h2>${editable ? "申請修改資料" : "變更申請"}</h2>${badge(r.status)}</div><ol class="steps" aria-label="申請流程"><li ${editable ? 'aria-current="step"' : ""}><span>1</span>填寫並儲存</li><li ${r.status === "pending" ? 'aria-current="step"' : ""}><span>2</span>送出審核</li><li><span>3</span>核准後生效</li></ol>`;
      const feedback = p.events.find(e => e.request_id === r.id && e.action === "return");
      if (feedback && ["draft", "returned"].includes(r.status))
        request += `<div class="notice returned"><strong>請依審核意見調整</strong><p>${escape(feedback.reason)}</p></div>`;
      if (r.status === "pending")
        request += '<p class="notice">申請已送出，正在等待審核。正式資料會在核准後更新。</p>';
      if (editable) request += form("save", hidden("baseRevision", p.profile.revision) +
        `<div class="fields">${fieldKeys(kind).map(k => field(k, r.data[k] ?? "", kind, prefix)).join("")}<div class="field"><label for="${prefix}request-reason">申請說明 <span class="required">選填</span></label><textarea id="${prefix}request-reason" name="reason" rows="3" maxlength="1000" placeholder="例如：搬家後更新通訊地址">${escape(r.reason)}</textarea></div></div><div class="actions"><button>儲存草稿</button><small>儲存後，請在下方確認內容並送出審核。</small></div>`);
      request += `<details class="comparison" ${editable ? "" : "open"}><summary>${editable ? "確認已儲存的內容與送出" : "檢視申請內容"}</summary><p class="hint">${editable ? "此處僅顯示已儲存的草稿；修改上方欄位後，請先按「儲存草稿」。" : "比對正式資料與本次申請內容。"}</p>${fieldKeys(kind).map(k => `<div class="compare-row ${!sameValue(k, p.profile.data[k] ?? "", r.data[k] ?? "") ? "changed" : ""}"><h3>${labels[k]}</h3><div class="compare-values"><div class="previous"><small>正式資料</small><p>${escape(displayValue(k, p.profile.data[k] ?? ""))}</p></div><div class="proposed"><small>申請內容${!sameValue(k, p.profile.data[k] ?? "", r.data[k] ?? "") ? " · 已修改" : " · 未變更"}</small><p>${escape(displayValue(k, r.data[k] ?? ""))}</p></div></div></div>`).join("")}${r.reason ? `<p class="hint">申請說明：${escape(r.reason)}</p>` : ""}`;
      if (p.canEdit && r.status === "draft") request += form("submit", '<div class="actions"><button>確認送出審核</button><small>送出後須經審核才會更新正式資料。</small></div>');
      if (p.canEdit && r.status === "returned") request += '<p class="hint">請先儲存修改後的草稿，再重新送出。</p>';
      request += '</details>';
      if (p.canReview && r.status === "pending") {
        request += '<div class="review-actions"><h3>審核決定</h3>';
        for (const [action, label, description, style] of [
          ["approve", "核准並更新正式資料", "核准後，申請內容將成為新的正式版本。", ""],
          ["return", "退回修改", "讓申請人補充或修正後重新送出。", "secondary"],
          ["reject", "不核准", "結束這次申請，保留正式資料與送審紀錄。", "danger"],
        ] as const) request += form(action, `<h3>${label}</h3><small>${description}</small><div class="field"><label for="${prefix}reason-${action}">審核說明 <span class="required">${action === "approve" ? "選填" : "必填"}</span></label><textarea id="${prefix}reason-${action}" name="reason" rows="2" maxlength="1000" ${action === "approve" ? "" : "required"}></textarea></div><div class="actions"><button class="${style}">${label}</button></div>`);
        request += '</div>';
      }
      if (p.canEdit) request += `<div class="withdraw">${form("withdraw", '<button class="secondary">撤回申請</button>')}<small>撤回不會更動正式資料，已送審的紀錄仍會保留。</small></div>`;
      request += '</section>';
    }
    return request;
  }
  const kindOf = (v: string) => z.enum(["family", "person"]).parse(v);
  const origin = new URL(config.AUTH_ISSUER).origin;
  app.use("*", bodyLimit({ maxSize: 131072 }));
  app.use("*", async (c, next) => {
    const nonce = crypto.randomUUID();
    c.set("nonce", nonce);
    c.header("Cache-Control", "private, no-store");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    // Native HTML forms use a strict Origin check, matching Auth administration.
    if (c.req.method !== "GET" && c.req.header("origin") !== origin)
      return c.html(page("無法送出", "<p>請從本網站送出表單。</p>"), 403);
    return next();
  });
  // Logout remains available even when profile access or the session has expired.
  app.post("/sign-out", async c => {
    const response = await auth.api.signOutLinkedApplications({ headers: c.req.raw.headers, asResponse: true });
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("location", "/profiles/signed-out");
    headers.delete("content-type");
    headers.delete("content-length");
    return new Response(null, { status: 303, headers });
  });
  app.get("/signed-out", async c => {
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (current && await hasLiveSession(db, current.user.id, current.session.id) && await isAdmin(db, config, current.user.id))
      return c.redirect("/admin", 303);
    return c.html(page("已登出", '<p>您已登出家庭與個人資料。</p><a class="button" href="/profiles">重新登入</a>'));
  });
  app.use("*", async (c, next) => {
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (
      !current ||
      !(await hasLiveSession(db, current.user.id, current.session.id))
    ) {
      if (c.req.method !== "GET")
        return c.html(page("請重新登入", '<a href="/profiles">登入</a>'), 403);
      return c.redirect(await profileAuthorizationUrl(db, config), 303);
    }
    const administrator = await isAdmin(db, config, current.user.id);
    if (options.administration && !administrator) throw new ProfileError(403, "需要管理員權限。");
    if (!options.administration && administrator) return c.redirect("/admin", 303);
    const [person] = await rows<{ display_name: string; normalized_login_email: string | null }>(db,
      sql`select display_name, normalized_login_email from directory.people where id=${current.user.id}`);
    c.set("account", { name: person?.display_name ?? current.user.name, email: person?.normalized_login_email ?? current.user.email });
    // Direct links initialize the native client too, without changing existing grants.
    if (!options.administration) await ensureProfileClient(db, config);
    c.set("actor", {
      personId: current.user.id,
      sessionId: current.session.id,
      clientId: options.administration ? "" : "smz-profiles",
    });
    return next();
  });
  app.get("/", async (c) => {
    return c.redirect(`${basePath}/family`, 303);
  });
  app.get("/:kind", async (c) => {
    const kind = kindOf(c.req.param("kind"));
    const h = await services[kind].home(c.get("actor"));
    const own = options.administration ? [] : ("families" in h ? h.families : h.people);
    const review = "reviewFamilies" in h ? h.reviewFamilies : h.reviewPeople;
    const subjects = [
      ...own,
      ...review.filter((p) => !own.some((o) => o.id === p.id) && !(options.administration && kind === "person" && p.id === c.get("actor").personId)),
    ];
    return c.html(
      page(
        options.administration ? (kind === "family" ? "家庭資料變更審核" : "個人資料變更審核") : (kind === "family" ? "家庭資料" : "個人資料"),
        `<div class="home-grid">${h.canReview ? `<section class="panel"><div class="panel-head"><h2>待審核申請</h2><span class="badge pending">${h.queue.length} 筆</span></div>${h.queue.length ? `<ul class="subject-list">${h.queue.map((q) => `<li><a href="${basePath}/${kind}/${q.family_id ?? q.person_id}">${escape(q.family_name ?? q.person_name)}</a></li>`).join("")}</ul>` : '<p class="empty">目前沒有待審核申請。</p>'}</section>` : ""}<section class="panel"><div class="panel-head"><h2>${h.canReview ? "可查看的資料" : kind === "family" ? "我的家庭" : "我與同家庭家長的資料"}</h2></div>${subjects.length ? `<ul class="subject-list">${subjects.map((p) => `<li><a href="${basePath}/${kind}/${p.id}">${escape(p.name)}</a></li>`).join("")}</ul>` : '<p class="empty">目前沒有可查看的資料。</p>'}</section></div>`,
        kind,
        c.get("account"),
      ),
    );
  });
  app.get("/:kind/:id", async (c) => {
    const kind = kindOf(c.req.param("kind")),
      id = z.uuid().parse(c.req.param("id"));
    const result = await services[kind].profile(c.get("actor"), id);
    const p = options.administration ? { ...result, canEdit: false, ...("canEditBundle" in result ? {canEditBundle: false} : {}) } : result;
    const subject = "family" in p ? p.family : p.person,
      r = p.openRequest;
    const actionUrl = `${basePath}/${kind}/${id}`;
    const delegatedNotice = "isOwnProfile" in p && !p.isOwnProfile && p.canEdit
      ? '<p class="notice">您正在代同家庭的家長或監護人申請修改。資料本人可查看此申請；變更仍須由獨立審核人員核准。</p>' : "";
    const current = `<section class="panel"><div class="panel-head"><h2>正式資料</h2><span class="badge">第 ${p.profile.revision} 版</span></div>${values(p.profile.data, kind)}<p class="panel-footer">${kind === "person" ? "聯絡信箱不會變更登入信箱。角色與家庭關係由學校管理。" : "此處顯示已核准的家庭聯絡資料。"}</p></section>`;
    const members = "members" in p ? `<section class="panel"><div class="panel-head"><h2>家庭成員</h2></div>${p.members.map((m) => `<article class="member"><h3>${escape(m.name)}<span class="relationship">${escape(({ father: "父親", mother: "母親", guardian: "監護人", child: "孩子" } as Record<string, string>)[m.relationship] ?? m.relationship)}</span></h3>${m.kind === "adult" && ["father", "mother", "guardian"].includes(m.relationship) && (p.canEdit || c.get("actor").personId === m.id) ? `<a class="member-edit" href="#parent-${m.id}" aria-label="修改${escape(m.name)}的資料">修改資料 →</a>` : ""}${m.kind === "adult" ? values({ contactPhone: m.contact_phone, contactEmail: m.contact_email }, "person", ["contactPhone", "contactEmail"]) : ""}</article>`).join("")}</section>` : "";
    const request = renderRequest(p, kind, actionUrl);
    const actions: Record<string, string> = { created: "建立草稿", saved: "儲存草稿", submit: "送出申請", approve: "核准", return: "退回修改", reject: "不核准", withdraw: "撤回" };
    const submissions = p.submissions as unknown as Array<{ version: number; status: string; data: Record<string, string>; reason: string }>;
    const history = `<details class="panel history"><summary>修訂與申請紀錄</summary><div class="history-grid"><section><h2>正式修訂紀錄</h2>${"fullHistory" in p && !p.fullHistory ? '<p class="empty">個人修訂紀錄僅供資料本人與審核人員查看。</p>' : p.revisions.length ? p.revisions.map(v => `<details class="record"><summary>${v.revision === 0 ? "初始紀錄" : `第 ${v.revision} 版`}<small>${escape(timestamp(v.approved_at))} · ${escape(v.approved_name ?? "既有資料")}</small></summary>${values(v.data, kind)}${kind === "family" ? adultSummary(v.data) : ""}</details>`).join("") : '<p class="empty">核准後的版本會保留在這裡。</p>'}</section><section><h2>送審與處理紀錄</h2>${submissions.map(v => `<details class="record"><summary>送審版本 ${v.version} ${badge(v.status)}</summary>${values(v.data, kind)}${kind === "family" ? adultSummary(v.data) : ""}${v.reason ? `<p>${escape(v.reason)}</p>` : ""}</details>`).join("")}${p.events.length ? `<ol class="timeline">${p.events.map(e => `<li><time>${escape(timestamp(e.occurred_at))}</time><strong>${escape(actions[e.action] ?? e.action)}</strong> · ${escape(e.actor_name)}${e.reason ? `<p>${escape(e.reason)}</p>` : ""}</li>`).join("")}</ol>` : '<p class="empty">目前沒有送審或處理紀錄。</p>'}</section></div></details>`;
    const graph = "members" in p ? familyGraph(subject.name, p.members.map(m => ({ name: m.name, kind: m.kind, relationship: m.relationship }))) : "";
    if ("family" in p) return c.html(page(subject.name, `${graph}${familyDetails(p, c.req.query("edit") === "1", basePath)}${history}<script nonce="${c.get("nonce")}">${familyFormScript}</script>`, kind, c.get("account")));
    const body = `${delegatedNotice}${graph}<div class="workspace"><div class="stack">${current}${members}</div><div class="stack">${request || '<section class="panel"><h2>目前沒有進行中的申請</h2><p class="empty">申請人送出資料變更後，即可在此查看內容與審核。</p></section>'}</div></div>${history}`;
    return c.html(page(subject.name, body, kind, c.get("account")));
  });

  app.post("/family/:id/submit-all", async c => {
    if (options.administration) throw new ProfileError(403, "管理審核頁面僅供審核申請。");
    const id = z.uuid().parse(c.req.param("id"));
    const body = await c.req.parseBody();
    const indices = Object.keys(body).filter(k => /^adult-\d+-id$/.test(k)).map(k => k.split('-')[1]);
    const adults = indices.map(index => {
      const key = `adult-${index}-`;
      return { id: body[key+'id'] || null, relationship: body[key+'relationship'], removed: body[key+'removed'] === 'true',
        data: Object.fromEntries(fieldKeys('person').map(k => [k,body[key+k] ?? ''])) };
    });
    await services.family.submitForm(c.get('actor'), id, z.uuid().parse(body.requestId), {
      version: Number(body.version), submissionVersion: Number(body.submissionVersion), baseRevision: Number(body.baseRevision),
      rosterVersion: body.rosterVersion, mailingAddress: body.mailingAddress, contactPhone: body.contactPhone, adults, reason: body.reason ?? '',
    });
    return c.redirect(`${basePath}/family/${id}`,303);
  });
  app.post("/:kind/:id/:action", async (c) => {
    const kind = kindOf(c.req.param("kind")),
      id = z.uuid().parse(c.req.param("id"));
    const action = z
      .enum([
        "create",
        "save",
        "submit",
        "approve",
        "return",
        "reject",
        "withdraw",
      ])
      .parse(c.req.param("action"));
    if (options.administration && !["approve", "return", "reject"].includes(action)) throw new ProfileError(403, "管理審核頁面僅供審核申請。");
    const b = await c.req.parseBody(),
      requestId = z.uuid().parse(b.requestId),
      actor = c.get("actor"),
      service = services[kind];
    const familyId = b.familyId === undefined ? undefined : z.uuid().parse(b.familyId);
    if (familyId) {
      if (kind !== "person") throw new ProfileError(400, "無效的家庭表單。");
      const family = await services.family.profile(actor, familyId);
      if (!family.members.some(m => m.id === id && m.kind === "adult" && ["father", "mother", "guardian"].includes(m.relationship)))
        throw new ProfileError(403, "此人不是目前家庭的家長或監護人。");
    }
    // Verify the selected subject before accepting a request operation.
    const p = await service.profile(actor, id);
    if (action === "create") {
      if (kind === "person" && familyId && b.inline === "1")
        await services.person.create(actor, id, requestId, {
          baseRevision: z.coerce.number().int().nonnegative().parse(b.baseRevision),
          data: Object.fromEntries(fieldKeys("person").map(k => [k, b[k] ?? ""])),
          reason: b.reason ?? "",
        });
      else await service.create(actor, id, requestId);
    }
    else {
      if (p.openRequest?.id !== requestId)
        throw new ProfileError(409, "申請已更新，請重新載入。");
      const version = z.coerce.number().int().positive().parse(b.version);
      if (action === "save")
        await service.save(actor, requestId, {
          version,
          baseRevision: z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(b.baseRevision),
          data: Object.fromEntries(fieldKeys(kind).map((k) => [k, b[k] ?? ""])),
          reason: b.reason ?? "",
        });
      else
        await service.action(actor, requestId, action, {
          version,
          submissionVersion: z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(b.submissionVersion),
          reason: b.reason ?? "",
        });
    }
    return c.redirect(familyId ? `${basePath}/family/${familyId}#parent-${id}` : `${basePath}/${kind}/${id}`, 303);
  });
  app.onError((e, c) =>
    c.html(
      page(
        "無法完成操作",
        `<p role="alert">${escape(e instanceof ProfileError ? e.message : e instanceof ZodError ? "請檢查欄位格式。" : "服務暫時無法使用。")}</p><a href="${basePath}">重新載入</a>`,
        undefined,
        c.get("account"),
      ),
      e instanceof ProfileError ? e.status : e instanceof ZodError ? 400 : 503,
    ),
  );
  return app;
}
