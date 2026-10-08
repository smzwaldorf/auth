import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { isAdmin } from "../admin/service.js";
import { layout, escape as e } from "../admin/views.js";
import { hasLiveSession } from "../global-logout.js";
import { ProfileError } from "./service.js";
export function profileAdministration(db: Database, config: RuntimeConfig) {
  // Mounted beneath the existing admin session/origin middleware.
  const app = new Hono<{ Variables: { actorId: string; sessionId: string } }>();
  app.get("/", async (c) => {
    const reviewers = (
      await db.execute(
        sql`select p.id,p.display_name from directory.family_profile_reviewers r join directory.people p on p.id=r.person_id order by p.display_name`,
      )
    ).rows;
    const adults = (
      await db.execute(
        sql`select id,display_name from directory.people where kind='adult' and status='active' order by display_name`,
      )
    ).rows;
    const clients = (
      await db.execute(
        sql`select c.client_id,a.display_name,c.metadata->>'familyProfiles'='true' as enabled,c.metadata->>'personProfiles'='true' as person_enabled from auth.oauth_client c join directory.applications a on a.client_id=c.client_id where c.public=false and c.disabled=false order by a.display_name`,
      )
    ).rows;
    return c.html(
      layout(
        "家庭與個人資料權限",
        `<section class="card"><h1>家庭與個人資料權限</h1><p>管理員可審核家庭與個人資料。註冊組人員需另外指派；此權限不包含帳號管理。審核入口位於 Forms 的「家庭資料」及「個人資料」。</p><h2>註冊組人員</h2>${reviewers.map((r) => `<form class="inline" method="post"><input type="hidden" name="kind" value="reviewer"><input type="hidden" name="id" value="${e(r.id)}"><input type="hidden" name="enabled" value="false"><strong>${e(r.display_name)}</strong><button>撤銷審核權限</button></form>`).join("<br>") || "<p>尚未指派。</p>"}<form method="post"><input type="hidden" name="kind" value="reviewer"><input type="hidden" name="enabled" value="true"><label>新增審核人員<select name="id" required>${adults.map((p) => `<option value="${e(p.id)}">${e(p.display_name)}</option>`).join("")}</select></label><button>指派註冊組權限</button></form><h2>允許使用資料審核 API 的應用程式</h2><p>僅允許信任的伺服器應用程式。啟用後仍會檢查目前家庭關係、本人身分與審核權限。</p>${clients
          .flatMap((client) => [
            {
              client_id: client.client_id,
              display_name: client.display_name,
              enabled: client.enabled,
              kind: "client",
              label: "家庭資料",
            },
            {
              client_id: client.client_id,
              display_name: client.display_name,
              enabled: client.person_enabled,
              kind: "person-client",
              label: "個人資料",
            },
          ])
          .map(
            (cl) =>
              `<form method="post"><input type="hidden" name="kind" value="${cl.kind}"><input type="hidden" name="id" value="${e(cl.client_id)}"><input type="hidden" name="enabled" value="${cl.enabled ? "false" : "true"}"><strong>${e(cl.display_name)} · ${cl.label}</strong> · ${cl.enabled ? "已啟用" : "未啟用"} <button>${cl.enabled ? "停用" : "啟用"}</button></form>`,
          )
          .join("")}</section>`,
      ),
    );
  });
  app.post("/", async (c) => {
    const input = z
      .object({
        kind: z.enum(["reviewer", "client", "person-client"]),
        id: z.string().min(1).max(200),
        enabled: z.enum(["true", "false"]),
      })
      .parse(await c.req.parseBody());
    const actorId = c.get("actorId");
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      if (
        !(await hasLiveSession(tx, actorId, c.get("sessionId"))) ||
        !(await isAdmin(tx, config, actorId))
      )
        throw new ProfileError(403, "管理員權限已失效。");
      if (input.kind === "reviewer") {
        const id = z.uuid().parse(input.id);
        if (input.enabled === "true") {
          const result = await tx.execute(
            sql`insert into directory.family_profile_reviewers(person_id,granted_by) select id,${actorId}::uuid from directory.people where id=${id} and kind='adult' and status='active' on conflict(person_id) do nothing`,
          );
          if (
            !result.rowCount &&
            !(
              await tx.execute(
                sql`select 1 from directory.family_profile_reviewers where person_id=${id}`,
              )
            ).rowCount
          )
            throw new ProfileError(400, "請選擇有效的成人帳號。");
        } else
          await tx.execute(
            sql`delete from directory.family_profile_reviewers where person_id=${id}`,
          );
      } else {
        const capability =
          input.kind === "person-client" ? "personProfiles" : "familyProfiles";
        const result = await tx.execute(
          sql`update auth.oauth_client set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(${capability}::text,${input.enabled === "true"}::boolean) where client_id=${input.id} and public=false and disabled=false`,
        );
        if (!result.rowCount)
          throw new ProfileError(400, "請選擇有效的伺服器應用程式。");
      }
      await tx.execute(
        sql`insert into directory.audit_events(event_type,actor,detail) values('family_profile.permission.changed',${actorId},${JSON.stringify(input)}::jsonb)`,
      );
    });
    return c.redirect("/admin/family-profile-settings", 303);
  });
  app.onError((error, c) =>
    c.html(
      layout(
        "無法更新家庭與個人資料權限",
        `<section class="card"><h1>無法更新家庭與個人資料權限</h1><p>${e(error instanceof ProfileError ? error.message : "資料格式不正確或服務暫時無法使用。")}</p><a href="/admin/family-profile-settings">返回</a></section>`,
      ),
      error instanceof ProfileError ? error.status : 400,
    ),
  );
  return app;
}
