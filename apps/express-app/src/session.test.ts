import { describe, expect, it } from "vitest";
import { encryptSession, decryptSession } from "./session.js";
import { parseConfig } from "./config.js";
describe("server-side session encryption", () => {
  it("does not store token plaintext and rejects tampering or the wrong key", async () => {
    const data = { accessToken: "sensitive-access-token", refreshToken: "sensitive-refresh-token" };
    const secret = "a".repeat(40);
    const encrypted = await encryptSession(data, secret);
    expect(encrypted).not.toContain(data.accessToken);
    expect(await decryptSession(encrypted, secret)).toEqual(data);
    await expect(decryptSession(encrypted, "b".repeat(40))).rejects.toThrow();
    const [iv, body] = encrypted.split(".");
    const changed = Buffer.from(body!, "base64url"); changed[0] = changed[0]! ^ 1;
    await expect(decryptSession(`${iv}.${changed.toString("base64url")}`, secret)).rejects.toThrow();
  });
  it("uses a different IV for each save", async () => expect(await encryptSession({}, "key")).not.toEqual(await encryptSession({}, "key")));
});
it("rejects development settings in production", () => expect(() => parseConfig({}, true)).toThrow());

describe("database-free cookie sessions", () => {
  it("round-trips across instances, expires absolutely, and clears invalid cookies", async () => {
    const { CookieSession } = await import("./session.js");
    let now = 1000;
    const session = new CookieSession("test-key", () => now);
    await session.rotate();
    session.data = { accessToken: "access", refreshToken: "refresh", user: { sub: "person" } };
    const saved = await session.save();
    const next = new CookieSession("test-key", () => now);
    await next.load(saved.token);
    expect(next.data).toEqual(session.data);
    now += 1800_000;
    next.touch();
    expect((await next.save()).maxAge).toBe(1800);
    now += 1800_001;
    const expired = new CookieSession("test-key", () => now);
    await expired.load(saved.token);
    expect(expired.data).toEqual({});
    expect((await expired.save()).cleared).toBe(true);
    await next.destroy();
    expect((await next.save()).cleared).toBe(true);
  });
  it("serves anonymous routes and removes tampered sessions with no database", async () => {
    const { createApp } = await import("./app.js");
    const app = createApp(parseConfig({}, false));
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, storage: "encrypted-cookie" });
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/protected")).headers.get("location")).toBe("/login");
    expect((await app.request("/auth/callback")).status).toBe(400);
    const tampered = await app.request("/", { headers: { cookie: "smz.app-b.0=invalid" } });
    expect(tampered.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
