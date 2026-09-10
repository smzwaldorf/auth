import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

// Schema-only configuration for `npx auth@<matching-version> generate` when
// Better Auth is upgraded. Runtime configuration lives in src/auth.ts.
export const auth = betterAuth({
  baseURL: "http://localhost:3000/api/auth",
  secret: "schema-generation-secret-at-least-32-characters",
  socialProviders: {
    google: {
      clientId: "schema-generation-only",
      clientSecret: "schema-generation-only",
    },
  },
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email", "directory:access", "offline_access"],
      resources: [{
        identifier: "http://localhost:3000/api/directory/v1",
        name: "SMZ Directory API",
        allowedScopes: ["openid", "profile", "email", "directory:access", "offline_access"],
      }],
      silenceWarnings: { oauthAuthServerConfig: true },
    }),
  ],
});
