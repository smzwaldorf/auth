import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import { applications, oauthClient } from "../db/schema.js";
import type { RuntimeConfig } from "../runtime-config.js";

export async function ensureProfileClient(db: Database, config: RuntimeConfig) {
  const origin = new URL(config.AUTH_ISSUER).origin;
  const clientId = "smz-profiles";
  await db.transaction(async (tx) => {
    await tx
      .insert(oauthClient)
      .values({
        id: "client:smz-profiles",
        clientId,
        name: "Family and personal profiles",
        public: false,
        clientSecret: randomBytes(48).toString("base64url"),
        disabled: false,
        skipConsent: true,
        requirePKCE: true,
        redirectUris: [`${origin}/profiles`],
        scopes: ["openid", "profile", "email"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "client_secret_post",
        applicationType: "web",
        type: "web",
      })
      .onConflictDoNothing();
    await tx
      .insert(applications)
      .values({
        clientId,
        displayName: "Family and personal profiles",
        publicOrigin: origin,
        enabled: true,
      })
      .onConflictDoNothing();
  });
}

export async function profileAuthorizationUrl(
  db: Database,
  config: RuntimeConfig,
) {
  await ensureProfileClient(db, config);
  const origin = new URL(config.AUTH_ISSUER).origin;
  const clientId = "smz-profiles";
  // This same-origin panel uses the central session, not OAuth tokens. Discard
  // the verifier so the returned code cannot be exchanged. /profiles ignores the
  // code and still independently checks the live session and live admission and explicit profile client capabilities.
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const url = new URL(`${config.AUTH_ISSUER}/oauth2/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/profiles`,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(32).toString("base64url"),
  }).toString();
  return url.toString();
}
