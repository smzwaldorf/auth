import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../../src/auth.js";
import { config, directoryAudience } from "../../src/config.js";
import { closeDatabase, db } from "../../src/db/client.js";
import { oauthClient, oauthClientResource, oauthResource } from "../../src/db/schema.js";
import { applyDirectorySeed } from "../../src/seed/apply.js";
import { validateDirectorySeed } from "../../src/seed/model.js";

const enabled = process.env.RUN_DB_TESTS === "true";
const seed = validateDirectorySeed(
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "seeds/directory.seed.example.json"), "utf8")) as unknown,
);

function request(pathname: string, init?: RequestInit) {
  return auth.handler(new Request(new URL(pathname, config.AUTH_ISSUER), init));
}

describe.runIf(enabled).sequential("OAuth 2.1 and OIDC provider", () => {
  beforeAll(async () => applyDirectorySeed(seed));
  afterAll(async () => closeDatabase());

  it("publishes path-prefixed OIDC discovery with code, refresh, and S256 only", async () => {
    const response = await request("/api/auth/.well-known/openid-configuration");
    const metadata = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(metadata.issuer).toBe(config.AUTH_ISSUER);
    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("keeps a public and confidential client with exact redirects and required PKCE", async () => {
    const rows = await db.select().from(oauthClient).where(eq(oauthClient.disabled, false));
    const publicClient = rows.find((client) => client.clientId === "vite-app");
    const confidentialClient = rows.find((client) => client.clientId === "express-app");
    expect(publicClient).toMatchObject({ public: true, tokenEndpointAuthMethod: "none", requirePKCE: true });
    expect(publicClient?.redirectUris).toContain("http://localhost:5173/callback");
    expect(confidentialClient).toMatchObject({ public: false, tokenEndpointAuthMethod: "client_secret_post", requirePKCE: true });
    expect(confidentialClient?.redirectUris).toContain("http://localhost:4000/auth/callback");
    if (config.TAILSCALE_HOST) {
      expect(publicClient?.redirectUris).toContain(`https://${config.TAILSCALE_HOST}:${config.TAILSCALE_APP_A_PORT}/callback`);
      expect(confidentialClient?.redirectUris).toContain(`https://${config.TAILSCALE_HOST}:${config.TAILSCALE_APP_B_PORT}/auth/callback`);
    }
    expect(confidentialClient?.clientSecret).not.toBe(config.APP_B_CLIENT_SECRET);
  });

  it("binds every directory client to the persisted directory resource", async () => {
    const [resource] = await db.select().from(oauthResource).where(eq(oauthResource.identifier, directoryAudience));
    const links = await db.select().from(oauthClientResource).where(eq(oauthClientResource.resourceId, directoryAudience));
    expect(resource).toMatchObject({ identifier: directoryAudience, disabled: false, allowedScopes: ["directory:access"] });
    expect(links.map((link) => link.clientId).sort()).toEqual(["email-cms", "express-app", "vite-app"]);
  });

  it("rejects dynamic registration", async () => {
    const response = await request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:9999/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
  });

  it("accepts the exact public-client redirect and rejects a mismatched redirect", async () => {
    const common = `response_type=code&client_id=vite-app&scope=openid%20directory%3Aaccess&resource=${encodeURIComponent(directoryAudience)}&state=state-1&nonce=nonce-1&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_&code_challenge_method=S256`;
    const valid = await request(`/api/auth/oauth2/authorize?${common}&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}`);
    expect(valid.status).toBe(302);
    expect(valid.headers.get("location")).toContain("/sign-in?");

    const invalid = await request(`/api/auth/oauth2/authorize?${common}&redirect_uri=${encodeURIComponent("http://localhost:5173/not-registered")}`);
    expect([302, 400]).toContain(invalid.status);
    expect(invalid.headers.get("location") ?? await invalid.text()).toMatch(/redirect|invalid/i);

    const unexpectedResource = await request(`/api/auth/oauth2/authorize?${common.replace(encodeURIComponent(directoryAudience), encodeURIComponent("unregistered-resource"))}&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}`);
    expect([302, 400]).toContain(unexpectedResource.status);
    expect(unexpectedResource.headers.get("location") ?? await unexpectedResource.text()).toMatch(/resource|target|invalid/i);
  });

  it("carries the signed client authorization query into the Google login flow", async () => {
    const authorize = await request(
      `/api/auth/oauth2/authorize?response_type=code&client_id=vite-app&redirect_uri=${encodeURIComponent("http://localhost:5173/callback")}&scope=openid%20directory%3Aaccess&resource=${encodeURIComponent(directoryAudience)}&state=state-2&nonce=nonce-2&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_&code_challenge_method=S256`,
    );
    const loginLocation = authorize.headers.get("location");
    expect(loginLocation).toBeTruthy();
    const oauthQuery = new URL(loginLocation!, "http://localhost:3000").search.slice(1);
    const google = await request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "http://localhost:3000/",
        errorCallbackURL: "http://localhost:3000/sign-in?error=google",
        oauth_query: oauthQuery,
      }),
    });
    expect(google.status).toBe(200);
    expect(await google.json()).toMatchObject({ redirect: true, url: expect.stringMatching(/^https:\/\/accounts\.google\.com\//) });
  });
});
