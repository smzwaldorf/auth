import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const productionConfig = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://identity:secret@postgres.internal/smz_identity",
  AUTH_ISSUER: "https://identity.example.test/api/auth",
  BETTER_AUTH_SECRET: "a-production-secret-with-at-least-32-characters",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  MAGIC_LINK_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/auth/magic-link",
  MAGIC_LINK_DELIVERY_WEBHOOK_TOKEN: "mailer-shared-secret",
  DEV_LOGIN_ENABLED: "false",
  APP_B_CLIENT_SECRET: "production-app-b-client-secret",
} satisfies NodeJS.ProcessEnv;

describe("production configuration", () => {
  it("accepts an explicitly configured HTTPS deployment", () => {
    expect(parseConfig(productionConfig)).toMatchObject({
      NODE_ENV: "production",
      AUTH_ISSUER: productionConfig.AUTH_ISSUER,
      DEV_LOGIN_ENABLED: false,
    });
  });

  it("rejects development defaults and missing delivery credentials", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrow(/explicitly configured|HTTPS|false/);
  });

  it("rejects an HTTP issuer in production", () => {
    expect(() => parseConfig({ ...productionConfig, AUTH_ISSUER: "http://identity.example.test/api/auth" }))
      .toThrow(/HTTPS/);
  });
});
