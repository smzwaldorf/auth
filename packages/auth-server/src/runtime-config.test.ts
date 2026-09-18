import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, runtimeUrls } from "./runtime-config.js";
const production = { MAGIC_LINK_ENABLED: "false", NODE_ENV: "production", AUTH_ISSUER: "https://identity.school.test/api/auth", APP_A_ORIGIN: "https://a.school.test", APP_B_ORIGIN: "https://b.school.test", BETTER_AUTH_SECRET: "x".repeat(40), APP_B_CLIENT_SECRET: "y".repeat(40), GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" };
describe("production runtime configuration", () => {
  it("derives resource audience from the deployed issuer", () => expect(runtimeUrls(parseRuntimeConfig(production)).directoryAudience).toBe("https://identity.school.test/api/directory/v1"));
  it("rejects implicit development secrets and insecure origins", () => {
    expect(() => parseRuntimeConfig({ ...production, BETTER_AUTH_SECRET: undefined })).toThrow();
    expect(() => parseRuntimeConfig({ ...production, APP_A_ORIGIN: "http://a.school.test" })).toThrow();
    expect(() => parseRuntimeConfig({ ...production, AUTH_ISSUER: "https://identity.school.test/" })).toThrow();
  });
});

it("enables CMS only with an explicit secure deployment origin", () => {
  expect(runtimeUrls(parseRuntimeConfig(production)).trustedClientIds.has("email-cms")).toBe(false);
  expect(runtimeUrls(parseRuntimeConfig({ ...production, CMS_ORIGIN: "https://smz-cms.pages.dev" })).trustedClientIds.has("email-cms")).toBe(true);
  for (const CMS_ORIGIN of ["http://localhost:5174", "https://cms.example.com", "https://smz-cms.pages.dev/path", "https://user:password@smz-cms.pages.dev"]) expect(() => parseRuntimeConfig({ ...production, CMS_ORIGIN })).toThrow();
});

it("requires two distinct confirmed staging emails and delivery credentials before hosted magic links", () => {
  expect(() => parseRuntimeConfig({ ...production, MAGIC_LINK_ENABLED: "true" })).toThrow();
  const enabled = { ...production, MAGIC_LINK_ENABLED: "true", STAGING_ADMIN_EMAIL: "admin@example.invalid", STAGING_PARENT_EMAIL: "parent@example.invalid", RESEND_API_KEY: "re_test" };
  expect(parseRuntimeConfig(enabled).MAGIC_LINK_FROM).toBe("Aida <info@useaida.app>");
  expect(() => parseRuntimeConfig({ ...enabled, STAGING_PARENT_EMAIL: enabled.STAGING_ADMIN_EMAIL })).toThrow();
  expect(parseRuntimeConfig({ ...enabled, STAGING_PARENT_EMAILS: "second@example.invalid, third@example.invalid" }).STAGING_PARENT_EMAILS).toEqual(["second@example.invalid", "third@example.invalid"]);
  expect(() => parseRuntimeConfig({ ...enabled, STAGING_PARENT_EMAILS: `${enabled.STAGING_ADMIN_EMAIL}` })).toThrow();
  expect(() => parseRuntimeConfig({ ...enabled, STAGING_PARENT_EMAILS: `${enabled.STAGING_PARENT_EMAIL},second@example.invalid` })).toThrow();
  expect(() => parseRuntimeConfig({ ...enabled, RESEND_API_KEY: "" })).toThrow();
});

it("keeps magic links enabled when no flag is supplied", () => {
  expect(parseRuntimeConfig({}).MAGIC_LINK_ENABLED).toBe("true");
});

it("allows the plural parent setting without a legacy single parent", () => {
 const config=parseRuntimeConfig({STAGING_ADMIN_EMAIL:"admin@school.test",STAGING_PARENT_EMAILS:"a@school.test,b@school.test"});
 expect(config.STAGING_PARENT_EMAILS).toEqual(["a@school.test","b@school.test"]);
 expect(()=>parseRuntimeConfig({STAGING_ADMIN_EMAIL:"admin@school.test"})).toThrow(/at least one/);
});
