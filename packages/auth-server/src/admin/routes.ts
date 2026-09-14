import { relationshipInput, relationshipService } from "./relationships.js";
import { relationshipView } from "./relationship-views.js";
import { registrationInput, registrationService, registrationView, setupView } from "./registration.js";
import { applicationService } from "./application-service.js";
import { applicationsView } from "./application-views.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { createAuth } from "../auth-factory.js";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { isDevelopmentIdentity } from "../development/policy.js";
import { hasLiveSession } from "../global-logout.js";
import { AdminError, userInput } from "./model.js";
import { adminService, isAdmin } from "./service.js";
import { layout, editView, listView, escape, accountMenu } from "./views.js";

export function adminRoutes(db: Database, config: RuntimeConfig, auth: ReturnType<typeof createAuth>) {
  const app = new Hono<{ Variables: { actorId: string; sessionId: string } }>();
  const service = adminService(db, config);
  const accessService = applicationService(db, config);
  const origin = new URL(config.AUTH_ISSUER).origin;
  app.use("*", bodyLimit({ maxSize: 16384 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (c.req.method !== "GET" && c.req.header("origin") !== origin) return c.html(layout("Request denied", '<h1>Request denied</h1><p>Submit this form from the identity admin panel.</p>'), 403);
    if (["/admin/sign-in", "/admin/sign-out"].includes(c.req.path) && c.req.method === "POST") return next();
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    const live = current && await hasLiveSession(db, current.user.id, current.session.id);
    if (c.req.path === "/admin/sign-in" && c.req.method === "GET") {
      if (live) return c.redirect("/admin", 303);
      return c.html(layout("Admin sign-in", '<section class="card"><h1>Administrator sign-in</h1><p>Sign in with a school-approved administrator account.</p><a class="button" href="/sign-in?admin=1">Sign in</a></section>', false), 200);
    }
    if (!current || !live) return c.redirect("/admin/sign-in", 303);
    if (!(await isAdmin(db, config, current.user.id))) {
      if (c.req.path !== "/admin" || c.req.method !== "GET") return c.redirect("/admin", 303);
      return c.html(layout("Not authenticated", '<section class="card"><h1>Not authenticated</h1><p role="alert">Your current account does not have administrator access. Sign out to use an administrator account.</p><form method="post" action="/admin/sign-out"><button type="submit">Sign out</button></form></section>', false), 403);
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
  app.post("/sign-out", async c => {
    const response = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("location", "/admin");
    headers.delete("content-type"); headers.delete("content-length");
    return new Response(null, { status: 303, headers });
  });
  app.post("/sign-in", c => c.redirect("/sign-in?admin=1", 303));
  app.get("/", async c => {
    const q = (c.req.query("q") || "").slice(0, 120);
    const page = Math.min(100000, Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1));
    const status = c.req.query("status") || "";
    return c.html(listView(await service.list(q, page, status), q, page, status));
  });
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
  app.post("/applications/access", c => c.html(layout("Automatic application access", '<h1>Application access is automatic</h1><p>Per-user grants are no longer used. Manage account status and login approval under Users.</p><a href="/admin">Manage users</a>'), 409));
  const relationships = relationshipService(db, config);
  for (const section of ["families", "students", "classes"] as const) app.get(`/${section}`, async c => {
    const id = c.req.query("id") || "";
    if (id && id !== "new" && !z.uuid().safeParse(id).success) return c.notFound();
    return c.html(relationshipView(await relationships.snapshot(), section, id, (c.req.query("q") || "").slice(0,120), c.req.query("saved") === "1"));
  });
  app.post("/directory/save", async c => {
    const body = await c.req.parseBody();
    const parsed = relationshipInput.safeParse(body);
    if (!parsed.success) return c.html(layout("Check directory details", `<h1>Check directory details</h1><p>${escape(parsed.error.issues.map(i => i.message).join("; "))}</p><p>Use Back to correct your entries.</p>`), 400);
    try {
      const result = await relationships.save(c.get("actorId"), c.get("sessionId"), parsed.data);
      const id = parsed.data.kind.endsWith("-member") ? parsed.data.groupId : result.id;
      return c.redirect(`/admin/${result.section}?id=${id}&saved=1`, 303);
    } catch (error) {
      if (error instanceof AdminError) return c.html(layout("Unable to save", `<h1>Unable to save directory</h1><p role="alert">${escape(error.message)}</p><a href="/admin/families">Review directory</a>`), error.status);
      throw error;
    }
  });
  app.get("/users/new", async c => c.html(editView(null, await service.apps())));
  app.get("/users/:id", async c => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.notFound();
    const person = await service.detail(id.data);
    if (!person) return c.notFound();
    return c.html(editView(person, await service.apps(), { saved: c.req.query("saved") === "1", signedOut: c.req.query("signedOut") === "1", readOnly: person.kind !== "adult" || !person.normalizedLoginEmail || isDevelopmentIdentity(person.id) }));
  });
  app.post("/users/:id/sign-out", async c => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.notFound();
    try {
      await service.forceSignOut(c.get("actorId"), c.get("sessionId"), id.data);
      return c.redirect(`/admin/users/${id.data}?signedOut=1`, 303);
    } catch (error) {
      if (error instanceof AdminError) return c.html(layout("Unable to sign out user", `<h1>Unable to sign out user</h1><p role="alert">${escape(error.message)}</p><a href="/admin">Return to users</a>`), error.status);
      throw error;
    }
  });
  app.post("/users/:id?", async c => {
    const id = c.req.param("id");
    if (id && !z.uuid().safeParse(id).success) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const array = (key: string) => body[key] === undefined ? [] : Array.isArray(body[key]) ? body[key] : [body[key]];
    let sites: unknown;
    try { sites = (array("sites") as unknown[]).map(value => JSON.parse(String(value))); }
    catch { return c.html(layout("Invalid site selection", '<h1>Invalid site selection</h1><p>Reload the user form and try again.</p>'), 400); }
    const parsed = userInput.safeParse({ ...body, roles: array("roles"), sites });
    if (!parsed.success) return c.html(layout("Check user details", `<h1>Check user details</h1><div class="notice error" role="alert">${escape(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "))}</div><p>Use your browser’s Back button to correct the form without losing your entries.</p>`), 400);
    try {
      const targetId = await service.save(c.get("actorId"), c.get("sessionId"), id, parsed.data);
      return c.redirect(`/admin/users/${targetId}?saved=1`, 303);
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code || (error as { code?: string }).code;
      if (error instanceof AdminError || code === "23505") return c.html(layout("Unable to save", `<h1>Unable to save user</h1><div class="notice error" role="alert">${escape(error instanceof AdminError ? error.message : "That email is already assigned to a user. No changes were saved.")}</div><p>Use your browser’s Back button to review your entries, or <a href="/admin">return to users</a>.</p>`), error instanceof AdminError ? error.status : 409);
      throw error;
    }
  });
  return app;
}
