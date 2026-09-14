import { describe, expect, it } from "vitest";
import { protectSelf, userInput } from "./model.js";
const valid = { displayName: " Person ", email: " PERSON@EXAMPLE.COM ", status: "active", roles: ["parent"], clients: [], approval: "approved" };
describe("admin input", () => {
  it("normalizes names and emails and refuses unsupported roles", () => {
    expect(userInput.parse(valid)).toMatchObject({ displayName: "Person", email: "person@example.com" });
    expect(userInput.safeParse({ ...valid, roles: ["student"] }).success).toBe(false);
    expect(userInput.safeParse({ ...valid, roles: [] }).success).toBe(false);
  });
  it("blocks every self-lockout path", () => {
    const input = userInput.parse({ ...valid, roles: ["admin"] });
    expect(() => protectSelf("a", "a", input)).not.toThrow();
    for (const change of [{ status: "disabled" as const }, { approval: "revoked" as const }, { roles: ["parent" as const] }]) expect(() => protectSelf("a", "a", { ...input, ...change })).toThrow();
  });
});
