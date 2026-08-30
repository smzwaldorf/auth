import assert from "node:assert/strict";
import test from "node:test";

import { loadAppConfig } from "./config.js";

const productionConfig = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://identity:secret@postgres.internal/smz_identity",
  AUTH_ISSUER: "https://identity.example.test/api/auth",
  APP_B_CLIENT_SECRET: "production-app-b-client-secret",
  APP_B_COOKIE_SECRET: "a-production-cookie-secret-with-32-characters",
} satisfies NodeJS.ProcessEnv;

test("accepts explicit production settings and enables secure cookies", () => {
  const config = loadAppConfig(productionConfig);
  assert.equal(config.isProduction, true);
  assert.equal(config.issuer.href, productionConfig.AUTH_ISSUER);
});

test("rejects production placeholders", () => {
  assert.throws(() => loadAppConfig({ NODE_ENV: "production" }), /HTTPS|explicitly configured/);
});

test("rejects invalid service ports", () => {
  assert.throws(() => loadAppConfig({ APP_B_LISTEN_PORT: "70000" }), /valid TCP port/);
});
