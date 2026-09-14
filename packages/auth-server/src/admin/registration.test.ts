import { describe, expect, it } from "vitest";
import { registrationInput } from "./registration.js";
const valid = { displayName: "Portal", site: "https://portal.example", callback: "https://portal.example/callback", logout: "https://portal.example/", clientType: "public" };
describe("application registration URLs", () => {
  it("accepts HTTPS and explicit localhost development", () => {
    expect(registrationInput.safeParse(valid).success).toBe(true);
    expect(registrationInput.safeParse({ ...valid, site: "http://localhost:5500", callback: "http://localhost:5500/callback", logout: "http://localhost:5500/" }).success).toBe(true);
  });
  it("rejects unsafe origins and callback escapes", () => {
    for (const patch of [{ site: "http://portal.example" }, { site: "https://portal.example/path" }, { callback: "https://evil.example/callback" }, { callback: "https://portal.example/*" }, { callback: "https://user@portal.example/callback" }, { logout: "https://portal.example/#fragment" }, { clientType: "other" }]) expect(registrationInput.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
