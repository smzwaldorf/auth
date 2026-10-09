/** Synthetic, loopback-only full OIDC fixture. Never imported by the application. */
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { serve } from "@hono/node-server";
import { createRequire } from "node:module";
import pg from "pg";
import { createDatabase } from "../packages/auth-server/dist/db/database.js";
import { parseRuntimeConfig } from "../packages/auth-server/dist/runtime-config.js";
import { createApp } from "../packages/auth-server/dist/app.js";
import { createAuth } from "../packages/auth-server/dist/auth-factory.js";
const authRequire = createRequire(new URL("../package.json", import.meta.url));
const { migrate } = authRequire("drizzle-orm/node-postgres/migrator");
if (process.env.NODE_ENV !== "test") throw Error("Test mode required");
const env = parse(await readFile(".env", "utf8")),
  url = new URL(env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Loopback database required");
const maintenance = new pg.Pool({ connectionString: url.href });
for (const name of ["smz_family_profiles_ui_test"])
  if (
    !(
      await maintenance.query("select 1 from pg_database where datname=$1", [
        name,
      ])
    ).rowCount
  )
    await maintenance.query(`create database ${name}`);
await maintenance.end();
url.pathname = "/smz_family_profiles_ui_test";
const { db, pool, close } = createDatabase(url.href);
await migrate(db, {
  migrationsFolder: "packages/auth-server/drizzle",
});
const origin = "http://127.0.0.1:3018",
  formsOrigin = origin,
  clientId = "smz-profiles",
  secret = "synthetic-family-ui-client-secret-32-characters";
const config = parseRuntimeConfig({
  DATABASE_URL: url.href,
  NODE_ENV: "test",
  AUTH_ISSUER: `${origin}/api/auth`,
});
const actors = {};
if (process.env.PROFILE_UI_REUSE === "true") {
  for (const key of ["parent", "admin", "registrar"]) {
    const { rows } = await pool.query(
      "select id from directory.people where normalized_login_email=$1",
      [`${key}@family-ui.example.test`],
    );
    if (!rows[0])
      throw Error(
        "Existing UI fixture missing; run without PROFILE_UI_REUSE first",
      );
    actors[key] = rows[0].id;
  }
} else {
  await pool.query(
    'truncate directory.people, directory.families, auth.\"user\", auth.oauth_client cascade',
  );
  const resource = `${origin}/api/directory/v1`;
  await pool.query(
    `insert into auth.oauth_resource(id,identifier,name,allowed_scopes,access_token_ttl,refresh_token_ttl) values($1,$1,'Directory',$2,900,2592000) on conflict(identifier) do update set allowed_scopes=excluded.allowed_scopes,signing_algorithm=null,access_token_ttl=excluded.access_token_ttl,refresh_token_ttl=excluded.refresh_token_ttl`,
    [
      resource,
      ["openid", "profile", "email", "directory:access", "offline_access"],
    ],
  );
  await pool.query(
    `insert into auth.oauth_client(id,client_id,client_secret,name,public,disabled,skip_consent,enable_end_session,require_pkce,scopes,redirect_uris,post_logout_redirect_uris,token_endpoint_auth_method,application_type,type,grant_types,response_types,metadata,created_at,updated_at)
values($1,$1,$2,'Family UI Test',false,false,true,true,true,$3,$4,$5,'client_secret_post','web','web',$6,$7,'{"familyProfiles":true,"personProfiles":true,"clientId":"family-ui-test"}',now(),now())`,
    [
      clientId,
      createHash("sha256").update(secret).digest("base64url"),
      ["openid", "profile", "email", "directory:access", "offline_access"],
      [`${origin}/profiles`],
      [`${formsOrigin}/`],
      ["authorization_code", "refresh_token"],
      ["code"],
    ],
  );
  await pool.query(
    "insert into auth.oauth_client_resource(id,client_id,resource_id) values($1,$2,$3)",
    [randomUUID(), clientId, resource],
  );
  await pool.query(
    "insert into directory.applications(client_id,display_name,public_origin) values($1,'Family UI Test',$2)",
    [clientId, formsOrigin],
  );
  for (const [key, name, role] of [
    ["parent", "測試家長", "parent"],
    ["admin", "測試管理員", "admin"],
    ["registrar", "測試註冊組", "teacher"],
  ]) {
    const id = randomUUID(),
      email = `${key}@family-ui.example.test`;
    await pool.query(
      "insert into directory.people(id,kind,display_name,normalized_login_email) values($1,'adult',$2,$3)",
      [id, name, email],
    );
    await pool.query(
      'insert into auth."user"(id,name,email,email_verified) values($1,$2,$3,true)',
      [id, name, email],
    );
    await pool.query(
      "insert into directory.person_roles(person_id,role) values($1,$2)",
      [id, role],
    );
    await pool.query(
      "insert into directory.login_invitations(id,person_id,normalized_email,status) values($1,$2,$3,'activated')",
      [randomUUID(), id, email],
    );
    actors[key] = id;
  }
  await pool.query(
    "insert into directory.family_profile_reviewers(person_id,granted_by) values($1,$2)",
    [actors.registrar, actors.admin],
  );
  const family = randomUUID();
  await pool.query(
    "insert into directory.families(id,code,display_name) values($1,'UI-FAMILY','森林測試家庭')",
    [family],
  );
  await pool.query(
    "insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'guardian')",
    [randomUUID(), actors.parent, family],
  );
}
// Add a second parent and children without resetting existing demo profiles or requests.
const { rows: fixtureFamilies } = await pool.query("select id from directory.families where code='UI-FAMILY'");
if (fixtureFamilies[0]) {
  const secondParent = "f2000000-0000-4000-8000-000000000003";
  await pool.query("insert into directory.people(id,kind,display_name) values($1,'adult','示範媽媽') on conflict(id) do nothing", [secondParent]);
  await pool.query("insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'mother') on conflict(id) do nothing", ["f3000000-0000-4000-8000-000000000003", secondParent, fixtureFamilies[0].id]);
  await pool.query("update directory.family_memberships set relationship='father' where person_id=$1 and family_id=$2 and relationship='guardian'", [actors.parent, fixtureFamilies[0].id]);
  for (const [id, membershipId, name] of [
    ["f2000000-0000-4000-8000-000000000001", "f3000000-0000-4000-8000-000000000001", "示範孩子小樹"],
    ["f2000000-0000-4000-8000-000000000002", "f3000000-0000-4000-8000-000000000002", "示範孩子小葉"],
  ]) {
    await pool.query("insert into directory.people(id,kind,display_name) values($1,'student',$2) on conflict(id) do nothing", [id, name]);
    await pool.query("insert into directory.family_memberships(id,person_id,family_id,relationship) values($1,$2,$3,'child') on conflict(id) do nothing", [membershipId, id, fixtureFamilies[0].id]);
  }
}
const auth = createAuth(config, db),
  app = createApp(config, db);
app.get("/__fixture/sign-in/:actor", async (c) => {
  const id = actors[c.req.param("actor")];
  if (!id) return c.text("Unknown synthetic actor", 404);
  const session = await (await auth.$context).internalAdapter.createSession(id);
  const signature = createHmac("sha256", config.BETTER_AUTH_SECRET)
    .update(session.token)
    .digest("base64");
  c.header(
    "Set-Cookie",
    `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return c.redirect(`${origin}/profiles`);
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 3018 });
const stop = () => {
  server.close();
  void close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`Synthetic parent: ${origin}/__fixture/sign-in/parent`);
console.log(`Synthetic admin: ${origin}/__fixture/sign-in/admin`);
console.log(`Synthetic registrar: ${origin}/__fixture/sign-in/registrar`);
