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
