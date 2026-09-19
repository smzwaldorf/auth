import { familyWizard } from "./family-wizard.js";
import { classesList, directoryInsights, familiesList, groupContext, personContext, relationshipInput, relationshipService, studentsList, type ListFilters, type Snapshot } from "./relationships.js";
import { classDetailView, classesListView, familiesListView, familyDetailView, recordFormView, studentDetailView, studentsListView, type PageOptions, type Section } from "./relationship-views.js";
import { registrationInput, registrationService, registrationView, setupView } from "./registration.js";
import { applicationService } from "./application-service.js";
import { applicationsView } from "./application-views.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { defaultLocale, localeCookie, parseLocale, t, withLocale } from "./i18n.js";
import { z } from "zod";
import type { createAuth } from "../auth-factory.js";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { isDevelopmentIdentity } from "../development/policy.js";
import { hasLiveSession } from "../global-logout.js";
import { AdminError, userInput } from "./model.js";
import { adminService, isAdmin } from "./service.js";
import { layout, editView, usersListView, dashboardView, escape, accountMenu, type EditOptions } from "./views.js";

const sections = ["families", "students", "classes"] as const;
const uuid = (value: string | undefined) => z.uuid().safeParse(value).success ? value! : null;
const clip = (value: string | undefined, max = 120) => (value || "").slice(0, max);
export function adminRoutes(db: Database, config: RuntimeConfig, auth: ReturnType<typeof createAuth>) {
  const app = new Hono<{ Variables: { actorId: string; sessionId: string } }>();
  const service = adminService(db, config);
  const accessService = applicationService(db, config);
  const origin = new URL(config.AUTH_ISSUER).origin;
  app.use("*", bodyLimit({ maxSize: 16384 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // Every response (including sign-in and error pages) renders in the visitor's chosen language; Traditional Chinese by default.
    const locale = parseLocale(getCookie(c, localeCookie)) ?? defaultLocale;
    const requestPath = c.req.path + (c.req.method === "GET" && new URL(c.req.url).search ? new URL(c.req.url).search : "");
    return withLocale(locale, requestPath, async () => {
      if (c.req.method !== "GET" && c.req.header("origin") !== origin) return c.html(layout(t("Request denied"), `<section class="card"><h1>${escape(t("Request denied"))}</h1><p>${escape(t("Submit this form from the identity admin panel."))}</p></section>`, false), 403);
      if (["/admin/sign-in", "/admin/sign-out", "/admin/lang"].includes(c.req.path) && c.req.method === "POST") return next();
      const current = await auth.api.getSession({ headers: c.req.raw.headers });
      const live = current && await hasLiveSession(db, current.user.id, current.session.id);
      if (c.req.path === "/admin/sign-in" && c.req.method === "GET") {
        if (live) return c.redirect("/admin", 303);
        return c.html(layout(t("Admin sign-in"), `<section class="card"><span class="eyebrow">SMZ Identity</span><h1>${escape(t("Administrator sign-in"))}</h1><p class="lede">${escape(t("Sign in with a school-approved administrator account."))}</p><a class="btn" href="/sign-in?admin=1">${escape(t("Sign in"))}</a></section>`, false), 200);
      }
      if (!current || !live) return c.redirect("/admin/sign-in", 303);
      if (!(await isAdmin(db, config, current.user.id))) {
        if (c.req.path !== "/admin" || c.req.method !== "GET") return c.redirect("/admin", 303);
        return c.html(layout(t("Not authenticated"), `<section class="card"><h1>${escape(t("Not authenticated"))}</h1><p role="alert">${escape(t("Your current account does not have administrator access. Sign out to use an administrator account."))}</p><form method="post" action="/admin/sign-out"><button type="submit">${escape(t("Sign out"))}</button></form></section>`, false), 403);
      }
      c.set("actorId", current.user.id);
      c.set("sessionId", current.session.id);
      await next();
      if (c.res.headers.get("content-type")?.includes("text/html")) {
        const html = await c.res.text();
        if (html.includes("<!--signed-in-account-->")) {
          const person = await service.detail(current.user.id);
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(html.replace("<!--signed-in-account-->", person ? accountMenu(person) : ""), { status: c.res.status, headers });
        } else {
          c.res = new Response(html, { status: c.res.status, headers: c.res.headers });
        }
      }
    });
  });
  app.post("/lang", async c => {
    const body = await c.req.parseBody();
    const lang = parseLocale(typeof body.lang === "string" ? body.lang : "");
    const returnTo = typeof body.returnTo === "string" && /^\/admin(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.+]*)?$/.test(body.returnTo) ? body.returnTo : "/admin";
    if (lang) setCookie(c, localeCookie, lang, { path: "/admin", httpOnly: true, sameSite: "Lax", secure: origin.startsWith("https:"), maxAge: 60 * 60 * 24 * 365 });
    return c.redirect(returnTo, 303);
  });
  app.post("/sign-out", async c => {
    const response = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("location", "/admin");
    headers.delete("content-type"); headers.delete("content-length");
    return new Response(null, { status: 303, headers });
  });
  app.post("/sign-in", c => c.redirect("/sign-in?admin=1", 303));
  const relationships = relationshipService(db, config);
  // ---- Overview -------------------------------------------------------------------
  app.get("/", async c => {
    const [snapshot, extra] = await Promise.all([relationships.snapshot(), service.overview()]);
    return c.html(dashboardView(directoryInsights(snapshot), extra));
  });
  // ---- Applications ---------------------------------------------------------------
  app.get("/applications", async c => c.html(applicationsView(await accessService.list())));
  const registrations = registrationService(db, config);
  app.get("/applications/new", c => c.html(registrationView()));
  app.post("/applications/register", async c => {
    const body = await c.req.parseBody();
    const parsed = registrationInput.safeParse(body);
    if (!parsed.success) return c.html(registrationView(body, parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")), 400);
    try {
      const result = await registrations.create(c.get("actorId"), c.get("sessionId"), parsed.data);
      return c.html(setupView((await registrations.get(result.clientId))!, config, result.secret), 201);
    } catch (error) {
      if (error instanceof AdminError) return c.html(registrationView(body, error.message), error.status);
      throw error;
    }
  });
  app.get("/applications/setup/:clientId", async c => {
    const row = await registrations.get(c.req.param("clientId"));
    return row ? c.html(setupView(row, config)) : c.notFound();
  });
  app.get("/applications/site", c => c.redirect("/admin/applications", 303));
  app.get("/applications/:clientId", c => c.redirect(`/admin/applications/setup/${encodeURIComponent(c.req.param("clientId"))}`, 303));
  app.post("/applications/access", c => c.html(layout(t("Automatic application access"), `<section class="card"><h1>${escape(t("Application access is automatic"))}</h1><p>${escape(t("Per-user grants are no longer used. Manage account status and login approval under Users."))}</p><a class="btn" href="/admin/users">${escape(t("Manage users"))}</a></section>`, true, "applications"), 409));
  // ---- Family setup wizard ------------------------------------------------------------
  const wizard = familyWizard(db, config);
  app.get("/families/wizard", async c => c.html(wizard.view(wizard.start(c.get("actorId")), await relationships.snapshot())));
  app.post("/families/wizard", async c => {
    const body = await c.req.parseBody();
    let draft: ReturnType<typeof wizard.read>;
    try { draft = wizard.read(String(body.draft || ""), c.get("actorId")); }
    catch { return c.html(layout(t("Setup expired"), `<section class="card"><h1>${escape(t("Family setup expired"))}</h1><p>${escape(t("Please start a new setup."))}</p><a class="btn" href="/admin/families/wizard">${escape(t("Start family setup"))}</a></section>`, true, "families"), 400); }
    try {
      if (body.action === "confirm") {
        const familyId = await wizard.create(draft, c.get("sessionId"));
        return c.redirect(`/admin/families/${familyId}?saved=1`, 303);
      }
      const data = await relationships.snapshot();
      return c.html(wizard.view(wizard.advance(draft, body, data), data));
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code || (error as { code?: string }).code;
      if (error instanceof AdminError || error instanceof z.ZodError || code === "23505") {
        const message = error instanceof z.ZodError ? error.issues.map(i => i.message).join(" ") : error instanceof AdminError ? error.message : t("A record with these details already exists. Go back and select the existing account.");
        return c.html(wizard.view(draft, await relationships.snapshot(), message), error instanceof AdminError ? error.status : 400);
      }
      throw error;
    }
  });
  // ---- Directory pages ----------------------------------------------------------------
  const listFilters = (c: { req: { query: (k: string) => string | undefined } }): ListFilters => ({
    q: clip(c.req.query("q")), page: Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1),
    classId: uuid(c.req.query("classId")) ?? "", familyId: uuid(c.req.query("familyId")) ?? "", needs: clip(c.req.query("needs"), 20), status: clip(c.req.query("status"), 10),
  });
  type RenderOptions = PageOptions & { values?: Record<string, unknown>; signedOut?: boolean };
  const pageOptions = (c: { req: { query: (k: string) => string | undefined } }): RenderOptions => ({ saved: c.req.query("saved") === "1", created: c.req.query("created") === "1", signedOut: c.req.query("signedOut") === "1", add: clip(c.req.query("add")) });
  /** Renders a directory or user page for a path, used both for GET and for re-rendering after a failed save. */
  async function renderPage(path: string, o: RenderOptions, snapshot?: Snapshot): Promise<{ html: string; status?: 404 } | null> {
    const data = snapshot ?? await relationships.snapshot();
    const [, section, id, tail] = path.match(/^\/admin\/(users|families|students|classes)(?:\/([^/]+))?(?:\/(edit))?$/) ?? [];
    if (!section) return null;
    if (section === "users" && id) {
      const person = await service.detail(id);
      if (!person) return { html: layout(t("Not found"), `<h1>${escape(t("User not found"))}</h1>`, true, "users"), status: 404 };
      const options: EditOptions = { saved: o.saved, signedOut: o.signedOut, error: o.error, addQuery: o.add, values: o.values, readOnly: !person.normalizedLoginEmail || isDevelopmentIdentity(person.id) };
      return { html: editView(person, options, personContext(data, id, o.add)) };
    }
    if (section === "users") return null;
    const sec = section as Section;
    if (id === "new") return { html: recordFormView(sec, null, data, { error: o.error, values: o.values }) };
    if (!id || !uuid(id)) return null;
    const record = sec === "students" ? data.persons.find(p => p.id === id && p.kind === "student") : (sec === "families" ? data.families : data.classes).find(r => r.id === id);
    if (!record) return { html: layout(t("Not found"), `<h1>${escape(sec === "students" ? t("Student not found") : sec === "families" ? t("Family not found") : t("Class not found"))}</h1>`, true, sec), status: 404 };
    if (tail === "edit") return { html: recordFormView(sec, record, data, { error: o.error, values: o.values }) };
    if (sec === "students") return { html: studentDetailView(personContext(data, id, o.add), o) };
    const ctx = groupContext(data, sec, id, o.add);
    return { html: sec === "families" ? familyDetailView(ctx, o) : classDetailView(ctx, o) };
  }
  for (const section of sections) {
    app.get(`/${section}`, async c => {
      const legacy = c.req.query("id");
      if (legacy) return c.redirect(`/admin/${section}/${legacy === "new" ? "new" : encodeURIComponent(legacy)}`, 303);
      const data = await relationships.snapshot(), f = listFilters(c);
      return c.html(section === "students" ? studentsListView(studentsList(data, f), f) : section === "families" ? familiesListView(familiesList(data, f), f) : classesListView(classesList(data, f), f));
    });
    app.get(`/${section}/:id/edit`, async c => {
      const page = await renderPage(`/admin/${section}/${c.req.param("id")}/edit`, pageOptions(c));
      return page ? c.html(page.html, page.status ?? 200) : c.notFound();
    });
    app.get(`/${section}/:id`, async c => {
      const id = c.req.param("id");
      if (section === "students" && uuid(id)) {
        const data = await relationships.snapshot();
        const adult = data.persons.find(p => p.id === id && p.kind === "adult");
        if (adult) return c.redirect(`/admin/users/${id}`, 303);
        const page = await renderPage(`/admin/students/${id}`, pageOptions(c), data);
        return page ? c.html(page.html, page.status ?? 200) : c.notFound();
      }
      const page = await renderPage(`/admin/${section}/${id}`, pageOptions(c));
      return page ? c.html(page.html, page.status ?? 200) : c.notFound();
    });
  }
  app.post("/directory/save", async c => {
    const body = await c.req.parseBody({ all: true });
    const returnTo = typeof body.returnTo === "string" ? body.returnTo : "";
    const fail = async (message: string, status: 400 | 403 | 404 | 409) => {
      const kind = String(body.kind || "");
      const path = returnTo || (sections.includes(kind as Section) && !body.id ? `/admin/${kind}/new` : "");
      const page = path ? await renderPage(path, { error: message, values: body }) : null;
      return c.html(page?.html ?? layout(t("Unable to save"), `<section class="card"><h1>${escape(t("Unable to save directory"))}</h1><div class="notice error" role="alert">${escape(message)}</div><a class="btn" href="/admin/families">${escape(t("Review directory"))}</a></section>`), status);
    };
    const parsed = relationshipInput.safeParse(body);
    if (!parsed.success) return fail(parsed.error.issues.map(i => i.message).join(" "), 400);
    try {
      const result = await relationships.save(c.get("actorId"), c.get("sessionId"), parsed.data);
      return c.redirect(`${result.path}?saved=1`, 303);
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code || (error as { code?: string }).code;
      if (error instanceof AdminError) return fail(error.message, error.status);
      if (code === "23505") return fail(t("A record with these details already exists."), 409);
      throw error;
    }
  });
  // ---- Users ------------------------------------------------------------------------
  app.get("/users", async c => {
    const f = { q: clip(c.req.query("q")), page: Math.min(100000, Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1)), status: clip(c.req.query("status"), 10), role: clip(c.req.query("role"), 10), kind: clip(c.req.query("kind"), 10) };
    return c.html(usersListView(await service.list(f.q, f.page, f.status, f.role, f.kind), f));
  });
  app.get("/users/new", async c => {
    const returnTo = c.req.query("returnTo") || "", role = c.req.query("role") || "";
    return c.html(editView(null, { returnTo: /^\/admin(\/[A-Za-z0-9_\-/]*)?$/.test(returnTo) ? returnTo : "", values: ["admin", "teacher", "parent"].includes(role) ? { roles: [role] } : undefined }));
  });
  app.get("/users/:id", async c => {
    const id = uuid(c.req.param("id"));
    if (!id) return c.notFound();
    const person = await service.detail(id);
    if (!person) return c.notFound();
    if (person.kind === "student") return c.redirect(`/admin/students/${id}`, 303);
    const page = await renderPage(`/admin/users/${id}`, pageOptions(c));
    return page ? c.html(page.html, page.status ?? 200) : c.notFound();
  });
  app.post("/users/:id/sign-out", async c => {
    const id = uuid(c.req.param("id"));
    if (!id) return c.notFound();
    try {
      await service.forceSignOut(c.get("actorId"), c.get("sessionId"), id);
      return c.redirect(`/admin/users/${id}?signedOut=1`, 303);
    } catch (error) {
      if (error instanceof AdminError) return c.html(layout(t("Unable to sign out user"), `<section class="card"><h1>${escape(t("Unable to sign out user"))}</h1><div class="notice error" role="alert">${escape(error.message)}</div><a class="btn" href="/admin/users">${escape(t("Return to users"))}</a></section>`, true, "users"), error.status);
      throw error;
    }
  });
  app.post("/users/:id?", async c => {
    const id = c.req.param("id");
    if (id && !uuid(id)) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const array = (key: string) => body[key] === undefined ? [] : Array.isArray(body[key]) ? body[key] : [body[key]];
    const returnTo = typeof body.returnTo === "string" && /^\/admin(\/[A-Za-z0-9_\-/]*)?$/.test(body.returnTo) ? body.returnTo : "";
    const fail = async (message: string, status: 400 | 403 | 404 | 409) => {
      const person = id ? await service.detail(id) : null;
      if (id && !person) return c.notFound();
      const options: EditOptions = { error: message, values: { ...body, roles: array("roles") }, returnTo };
      return c.html(editView(person, options, person ? personContext(await relationships.snapshot(), person.id) : undefined), status);
    };
    let sites: unknown;
    try { sites = (array("sites") as unknown[]).map(value => JSON.parse(String(value))); }
    catch { return fail(t("Invalid site selection. Reload the form and try again."), 400); }
    const parsed = userInput.safeParse({ ...body, roles: array("roles"), sites });
    if (!parsed.success) return fail(parsed.error.issues.map(i => `${i.path.join(".") || "form"}: ${i.message}`).join("; "), 400);
    try {
      const targetId = await service.save(c.get("actorId"), c.get("sessionId"), id, parsed.data);
      if (!id && returnTo) return c.redirect(`${returnTo}?created=1&add=${encodeURIComponent(parsed.data.email)}`, 303);
      return c.redirect(`/admin/users/${targetId}?saved=1`, 303);
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code || (error as { code?: string }).code;
      if (error instanceof AdminError) return fail(error.message, error.status);
      if (code === "23505") return fail(t("That email is already assigned to a user. No changes were saved."), 409);
      throw error;
    }
  });
  return app;
}
