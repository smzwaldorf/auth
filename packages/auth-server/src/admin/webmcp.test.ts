import { Hono } from "hono";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AdminError } from "./model.js";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), live: vi.fn(), session: vi.fn(), detail: vi.fn(), saveUser: vi.fn(), saveDirectory: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("./service.js", () => ({ isAdmin: mocks.admin, adminService: () => ({ detail: mocks.detail, save: mocks.saveUser }) }));
vi.mock("../global-logout.js", () => ({ hasLiveSession: mocks.live }));
vi.mock("./relationships.js", async importOriginal => ({ ...await importOriginal<typeof import("./relationships.js")>(), relationshipService: () => ({ snapshot: mocks.snapshot, save: mocks.saveDirectory }) }));
import { adminRoutes } from "./routes.js";
import { webMcpScript, webMcpTools } from "./webmcp.js";

const id = "a90fe724-5e41-4310-a86e-347d4fd01aa1";
const origin = "https://auth.example.test";
const app = new Hono().route("/admin", adminRoutes({} as never, { AUTH_ISSUER: origin } as never, { api: { getSession: mocks.session } } as never));
const request = (tool: string, body: unknown, requestOrigin: string | undefined = origin) => app.request(`${origin}/admin/webmcp/execute/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { id }, session: { id: "session" } });
  mocks.live.mockResolvedValue(true); mocks.admin.mockResolvedValue(true);
  mocks.snapshot.mockResolvedValue({ persons: [], families: [], classes: [], familyLinks: [], classLinks: [], roles: [], version: "a".repeat(64) });
});
describe("WebMCP authorization and service contract", () => {
  it("denies anonymous, revoked, non-admin and cross-origin requests without writes", async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect((await request("smz_save_user", {})).status).toBe(401);
    mocks.live.mockResolvedValueOnce(false);
    expect((await request("smz_save_user", {})).status).toBe(401);
    mocks.admin.mockResolvedValueOnce(false);
    expect((await request("smz_save_user", {})).status).toBe(403);
    expect((await request("smz_save_user", {}, "https://evil.test")).status).toBe(403);
    expect((await request("smz_save_user", {}, "")).status).toBe(403);
    expect(mocks.saveUser).not.toHaveBeenCalled();
  });
  it("protects discovery and script with the same live admin session", async () => {
    for (const path of ["tools", "client.js"]) {
      mocks.session.mockResolvedValueOnce(null);
      expect((await app.request(`${origin}/admin/webmcp/${path}`)).status).toBe(401);
    }
    const response = await app.request(`${origin}/admin/webmcp/tools`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).tools).toHaveLength(5);
  });
  it("loads the adapter only on authenticated pages with nonce CSP", async () => {
    mocks.detail.mockResolvedValue({ id, displayName: "Admin", normalizedLoginEmail: "admin@example.test", roles: ["admin"] });
    const response = await app.request(`${origin}/admin/users/new`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const nonce = html.match(/<script nonce="([^"]+)" src="\/admin\/webmcp\/client.js"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    mocks.session.mockResolvedValueOnce(null);
    expect(await (await app.request(`${origin}/admin/sign-in`)).text()).not.toContain("/webmcp/client.js");
  });
  it("resolves only supported admin destinations and creation/detail views", async () => {
    for (const destination of ["users", "students", "families", "classes"]) {
      for (const view of ["list", "new", "detail"]) {
        const response = await request("smz_navigate", { destination, view, ...(view === "detail" ? { id } : {}) });
        expect(await response.json()).toMatchObject({ path: `/admin/${destination}${view === "list" ? "" : view === "new" ? "/new" : `/${id}`}` });
      }
    }
    expect(await (await request("smz_navigate", { destination: "overview" })).json()).toMatchObject({ path: "/admin" });
    for (const input of [{ destination: "https://evil.test" }, { destination: "users", view: "detail" }, { destination: "users", id }, { destination: "overview", view: "new" }]) {
      expect((await request("smz_navigate", input)).status).toBe(400);
    }
    expect(mocks.saveUser).not.toHaveBeenCalled();
  });
  it("creates adults without an id and returns a navigable record", async () => {
    mocks.saveUser.mockResolvedValue(id);
    const input = { displayName: "New Parent", email: "new@example.test", roles: ["parent"], status: "active" };
    expect(await (await request("smz_save_user", input)).json()).toEqual({ id, path: `/admin/users/${id}`, saved: true });
    expect(mocks.saveUser).toHaveBeenCalledWith(id, "session", undefined, expect.objectContaining(input));
  });
  it("returns bounded search results and current directory version", async () => {
    mocks.snapshot.mockResolvedValueOnce({ persons: [], families: Array.from({ length: 30 }, (_, i) => ({ id: String(i), code: `F${i}`, displayName: "Family" })), classes: [], version: "a".repeat(64) });
    const response = await request("smz_list_records", { kind: "families", page: 2 });
    expect(await response.json()).toMatchObject({ total: 30, rows: Array.from({ length: 5 }, (_, i) => ({ id: String(i + 25), code: `F${i + 25}`, displayName: "Family" })), directoryVersion: "a".repeat(64) });
  });
  it("counts matching parents once even with multiple roles", async () => {
    mocks.snapshot.mockResolvedValueOnce({ persons: [{ id, kind: "adult", displayName: "Parent" }, { id: "teacher", kind: "adult", displayName: "Teacher" }], roles: [{ personId: id, role: "parent" }, { personId: id, role: "teacher" }, { personId: "teacher", role: "teacher" }], version: "a".repeat(64) });
    const response = await request("smz_list_records", { kind: "users", role: "parent" });
    expect(await response.json()).toMatchObject({ total: 1, rows: [{ id }] });
    expect((await request("smz_list_records", { kind: "families", role: "parent" })).status).toBe(400);
  });
  it("rejects malformed input and missing update versions", async () => {
    expect((await request("smz_list_records", { kind: "users", page: 0 })).status).toBe(400);
    expect((await request("smz_save_user", { id, displayName: "Adult", email: "a@example.test", roles: ["parent"], status: "active" })).status).toBe(400);
    expect((await request("smz_save_directory", { kind: "families", displayName: "Family", code: "F1" })).status).toBe(400);
    expect(mocks.saveUser).not.toHaveBeenCalled(); expect(mocks.saveDirectory).not.toHaveBeenCalled();
  });
  it("passes actor, session and concurrency version to existing audited services", async () => {
    mocks.saveUser.mockResolvedValue(id);
    const user = { id, displayName: "Adult", email: "a@example.test", roles: ["parent"], status: "active", version: "2026-10-15T00:00:00.000Z" };
    expect((await request("smz_save_user", user)).status).toBe(200);
    expect(mocks.saveUser).toHaveBeenCalledWith(id, "session", id, expect.objectContaining({ version: user.version, sites: [] }));
    mocks.saveDirectory.mockResolvedValue({ path: `/admin/families/${id}` });
    expect((await request("smz_save_directory", { kind: "families", displayName: "Family", code: "F1", version: "a".repeat(64) })).status).toBe(200);
    expect(mocks.saveDirectory).toHaveBeenCalledWith(id, "session", expect.objectContaining({ version: "a".repeat(64) }));
    mocks.saveDirectory.mockRejectedValueOnce(new AdminError("Stale directory", 409));
    expect((await request("smz_save_directory", { kind: "families", displayName: "Family", code: "F1", version: "a".repeat(64) })).status).toBe(409);
  });
  it("does not expose invitation or client details with adult records", async () => {
    mocks.detail.mockResolvedValue({ id, kind: "adult", displayName: "Adult", normalizedLoginEmail: "a@example.test", status: "active", roles: ["parent"], updatedAt: new Date("2026-10-15"), invitation: { secret: "hidden" }, clients: ["private"] });
    const response = await request("smz_get_record", { kind: "users", id });
    const result = await response.json();
    expect(result.version).toBe("2026-10-15T00:00:00.000Z");
    expect(JSON.stringify(result)).not.toContain("hidden"); expect(result.record.clients).toBeUndefined();
  });
});
describe("browser adapter", () => {
  it("is inert without browser support", () => { expect(() => runInNewContext(webMcpScript, { document: {} })).not.toThrow(); });
  it("returns navigation before leaving the document and rejects external paths", async () => {
    const registered: any[] = [];
    const assign = vi.fn();
    const schedule = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ path: "/admin/users/new", navigationScheduled: true }) });
    runInNewContext(webMcpScript, { document: { modelContext: { registerTool: async (tool: unknown) => { registered.push(tool); } } }, AbortController, fetch, console, URL, window: { location: { origin, assign } }, setTimeout: schedule });
    await vi.waitFor(() => expect(registered).toHaveLength(5));
    const navigate = registered.find(t => t.name === "smz_navigate");
    expect(JSON.parse(await navigate.execute({ destination: "users", view: "new" }))).toMatchObject({ navigationScheduled: true });
    expect(assign).not.toHaveBeenCalled();
    schedule.mock.calls[0]![0]();
    expect(assign).toHaveBeenCalledWith(`${origin}/admin/users/new`);
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ path: "https://evil.test/admin" }) });
    await expect(navigate.execute({ destination: "users" })).rejects.toThrow("Invalid navigation target");
  });
  it("registers tools, forwards cancellation and surfaces authorization failure", async () => {
    const registered: any[] = [];
    const signals: AbortSignal[] = [];
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ total: 0 }) });
    runInNewContext(webMcpScript, { document: { modelContext: { registerTool: async (tool: unknown, options: { signal: AbortSignal }) => { registered.push(tool); signals.push(options.signal); } } }, AbortController, fetch, console });
    await vi.waitFor(() => expect(registered).toHaveLength(5));
    const controller = new AbortController();
    expect(await registered[0].execute({ kind: "users" }, { signal: controller.signal })).toBe('{"total":0}');
    expect(fetch).toHaveBeenCalledWith("/admin/webmcp/execute/smz_list_records", expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: controller.signal }));
    fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "Sign in" }) });
    await expect(registered[0].execute({ kind: "users" })).rejects.toThrow("Sign in");
    expect(signals.every(s => s.aborted)).toBe(true);
    expect(webMcpTools.filter(t => t.annotations.consequentialHint)).toHaveLength(2);
  });
});
