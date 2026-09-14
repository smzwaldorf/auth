import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import { applications, oauthClient } from "../db/schema.js";
import type { RuntimeConfig } from "../runtime-config.js";

export async function adminAuthorizationUrl(db: Database, config: RuntimeConfig) {
  const origin = new URL(config.AUTH_ISSUER).origin;
  const clientId = "smz-admin";
  await db.transaction(async tx => {
    await tx.insert(oauthClient).values({
      id: "client:smz-admin", clientId, name: "Identity administration", public: true,
      disabled: false, skipConsent: true, requirePKCE: true,
      redirectUris: [`${origin}/admin`], scopes: ["openid", "profile", "email"],
      grantTypes: ["authorization_code"], responseTypes: ["code"],
      tokenEndpointAuthMethod: "none", applicationType: "web", type: "web",
    }).onConflictDoNothing();
    await tx.insert(applications).values({
      clientId, displayName: "Identity administration", publicOrigin: origin, enabled: true,
    }).onConflictDoNothing();
  });
  // This same-origin panel uses the central session, not OAuth tokens. Discard
  // the verifier so the returned code cannot be exchanged. /admin ignores the
  // code and still independently checks the live session and administrator role.
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const url = new URL(`${config.AUTH_ISSUER}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/admin`,
    response_type: "code", scope: "openid profile email", code_challenge: challenge,
    code_challenge_method: "S256", state: randomBytes(32).toString("base64url") }).toString();
  return url.toString();
}
