import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, runtimeUrls } from "./runtime-config.js";
const production = { NODE_ENV: "production", AUTH_ISSUER: "https://identity.school.test/api/auth", APP_A_ORIGIN: "https://a.school.test", APP_B_ORIGIN: "https://b.school.test", BETTER_AUTH_SECRET: "x".repeat(40), APP_B_CLIENT_SECRET: "y".repeat(40), GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" };
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
