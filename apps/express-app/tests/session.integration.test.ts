import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DatabaseSession } from "../src/session.js";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const secret = "test-session-encryption-key-32-characters";
describe.runIf(process.env.RUN_DB_TESTS === "true")("durable app sessions", () => {
  beforeAll(async () => { await pool.query("SELECT 1 FROM app_b.session LIMIT 1"); });
  afterAll(async () => { await pool.end(); });
  it("survives a fresh app instance, rotates IDs and cannot resurrect a logged-out session", async () => {
    async function transaction<T>(action: (session: DatabaseSession) => Promise<T>) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); const result = await action(new DatabaseSession(client, secret)); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const first = await transaction(async s => { await s.rotate(); s.data.accessToken = "private-token"; return s.save(); });
    expect(first.token).toBeTruthy();
    const second = await transaction(async s => { await s.load(first.token); expect(s.data.accessToken).toBe("private-token"); await s.rotate(); s.data.user = { sub: "test-person" }; return s.save(); });
    expect(second.token).not.toBe(first.token);
    await transaction(async s => { await s.load(first.token); expect(s.data).toEqual({}); s.data.accessToken = "stale-token"; s.touch(); await s.save(); });
    await transaction(async s => { await s.load(first.token); expect(s.data).toEqual({}); });
    await transaction(async s => { await s.load(second.token); expect(s.data.user?.sub).toBe("test-person"); await s.destroy(); await s.save(); });
    await transaction(async s => { await s.load(second.token); expect(s.data).toEqual({}); });
  });
  it("enforces expiration and handles anonymous routes without creating sessions", async () => {
    const client = await pool.connect();
    let token: string | undefined;
    try {
      await client.query("BEGIN"); const s = new DatabaseSession(client, secret); await s.rotate(); s.data.accessToken = "expired"; token = (await s.save()).token; await client.query("COMMIT");
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token!))).toString("hex");
      await client.query("UPDATE app_b.session SET expires_at = now() - interval '1 second' WHERE id = $1", [hash]);
      await client.query("BEGIN"); const expired = new DatabaseSession(client, secret); await expired.load(token); expect(expired.data).toEqual({}); await expired.destroy(); await client.query("COMMIT");
    } finally { client.release(); }
    const config = parseConfig({}, false);
    const app = createApp(config, pool);
    expect((await app.request("http://localhost:4000/")).status).toBe(200);
    expect((await app.request("http://localhost:4000/protected")).headers.get("location")).toBe("/login");
    expect((await app.request("http://localhost:4000/auth/callback?code=invalid")).status).toBe(400);
    const invalidLogout = await app.request("http://localhost:4000/logout/local?returnTo=https://evil.test");
    expect(invalidLogout.status).toBe(400);
    const logout = await app.request("http://localhost:4000/logout/local?returnTo=app-a");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await logout.text()).toContain("localhost:5173/logout-complete");
  });
});
