import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "./runtime-config.js";
import { stagingRoleAllowed } from "./login-policy.js";

const config = parseRuntimeConfig({
  NODE_ENV: "production",
  MAGIC_LINK_ENABLED: "false",
  AUTH_ISSUER: "https://identity.school.test/api/auth",
  APP_A_ORIGIN: "https://a.school.test",
  APP_B_ORIGIN: "https://b.school.test",
  BETTER_AUTH_SECRET: "x".repeat(40),
  APP_B_CLIENT_SECRET: "y".repeat(40),
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  STAGING_ADMIN_EMAIL: "admin@example.test",
  STAGING_PARENT_EMAIL: "parent@example.test",
  STAGING_PARENT_EMAILS: "demo-a@example.test,demo-b@example.test",
});

describe("hosted staging role allowlist", () => {
  it("allows additional parents only with parent role and no admin role", () => {
    expect(stagingRoleAllowed("demo-a@example.test", [{ role: "parent" }], config)).toBe(true);
    expect(stagingRoleAllowed("demo-a@example.test", [{ role: "parent" }, { role: "admin" }], config)).toBe(false);
    expect(stagingRoleAllowed("demo-b@example.test", [{ role: "teacher" }], config)).toBe(false);
  });

  it("keeps admin admission separate from the parent allowlist", () => {
    expect(stagingRoleAllowed("admin@example.test", [{ role: "admin" }], config)).toBe(true);
    expect(stagingRoleAllowed("admin@example.test", [{ role: "admin" }, { role: "parent" }], config)).toBe(true);
    expect(stagingRoleAllowed("unknown@example.test", [{ role: "parent" }], config)).toBe(false);
  });
});
