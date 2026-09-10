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
