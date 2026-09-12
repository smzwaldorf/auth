import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { createGlobalLogout } from "./global-logout.js";
import { jwt } from "better-auth/plugins";

import { createAuditRecorder } from "./audit-service.js";
import { runtimeUrls, type RuntimeConfig } from "./runtime-config.js";
import type { Database } from "./db/database.js";
import { loginInvitations, people, user } from "./db/schema.js";
import * as schema from "./db/schema.js";
import { createDirectory } from "./directory/service.js";
import { normalizeEmail } from "./seed/model.js";

export function createAuth(config: RuntimeConfig, db: Database) {
  const { directoryAudience, trustedClientIds, authOrigin } = runtimeUrls(config);
  const recordAuditEvent = createAuditRecorder(db);
  const { hasLiveAppAccess } = createDirectory(db);
  async function activeInvitationForUser(userId: string) {
    const now = new Date();
    const [row] = await db
      .select({
        invitationId: loginInvitations.id,
        invitationEmail: loginInvitations.normalizedEmail,
        personEmail: people.normalizedLoginEmail,
        authEmail: user.email,
        personStatus: people.status,
        personKind: people.kind,
      })
      .from(loginInvitations)
      .innerJoin(people, eq(people.id, loginInvitations.personId))
      .innerJoin(user, sql`${user.id} = ${loginInvitations.personId}::text`)
      .where(
        and(
          eq(loginInvitations.personId, userId),
          inArray(loginInvitations.status, ["pending", "activated"]),
          or(isNull(loginInvitations.expiresAt), gt(loginInvitations.expiresAt, now)),
        ),
      )
      .limit(1);
    return row?.personStatus === "active" &&
      row.personKind === "adult" &&
      row.invitationEmail === row.personEmail &&
      row.invitationEmail === normalizeEmail(row.authEmail)
      ? row
      : null;
  }

  function accessDenied(message: string): APIError {
    return new APIError("FORBIDDEN", { message, error: "access_denied" });
  }

  const auth = betterAuth({
    appName: "SMZ Identity",
    baseURL: config.AUTH_ISSUER,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_A_ORIGIN, config.APP_B_ORIGIN, authOrigin, ...(config.CMS_ORIGIN ? [config.CMS_ORIGIN] : [])],
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: false, disableSignUp: true },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        // Seeded adults start unverified; the first exact-email Google link is
        // what verifies them. mapProfileToUser still rejects unverified Google
        // emails, and the account-create hook still requires a live invitation.
        requireLocalEmailVerified: false,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    socialProviders: {
      google: {
        clientId: config.GOOGLE_CLIENT_ID || "google-not-configured",
        clientSecret: config.GOOGLE_CLIENT_SECRET || "google-not-configured",
        accessType: "online",
        // Users are pre-provisioned by the directory seed. The first Google
        // login still needs to create the provider account link; the hooks below
        // reject any identity that is not an active, invited adult.
        prompt: "select_account",
        scopes: ["openid", "profile", "email"],
        async mapProfileToUser(profile) {
          if (profile.email_verified !== true) {
            await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", detail: { reason: "google_email_unverified" } });
            throw accessDenied("Google did not verify this email address");
          }
          return {
            name: profile.name,
            email: normalizeEmail(profile.email),
            emailVerified: true,
            image: profile.picture,
          };
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", detail: { reason: "not_preapproved" } });
            throw accessDenied("This email is not pre-approved for SMZ Identity");
          },
        },
      },
      account: {
        create: {
          before: async (newAccount) => {
            if (newAccount.providerId !== "google") {
              await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", personId: newAccount.userId, detail: { reason: "provider_not_allowed" } });
              throw accessDenied("Google is the only enabled identity provider");
            }
            if (!(await activeInvitationForUser(newAccount.userId))) {
              await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", personId: newAccount.userId, detail: { reason: "invitation_inactive" } });
              throw accessDenied("This login invitation is missing, expired, or inactive");
            }
            return { data: newAccount };
          },
          after: async (newAccount) => {
            if (newAccount.providerId !== "google") return;
            const now = new Date();
            await db.transaction(async (tx) => {
              await tx
                .update(loginInvitations)
                .set({ status: "activated", activatedAt: now, updatedAt: now })
                .where(eq(loginInvitations.personId, newAccount.userId));
              await tx.update(user).set({ emailVerified: true, updatedAt: now }).where(eq(user.id, newAccount.userId));
            });
            await recordAuditEvent({ eventType: "identity.google.linked", actor: "better-auth", personId: newAccount.userId });
          },
        },
      },
      session: {
        create: {
          before: async (newSession) => {
            const [person] = await db
              .select({ status: people.status, kind: people.kind })
              .from(people)
              .where(eq(people.id, newSession.userId))
              .limit(1);
            if (!person || person.kind !== "adult" || person.status !== "active") {
              await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", personId: newSession.userId, detail: { reason: "person_inactive_or_student" } });
              throw accessDenied("This person cannot authenticate");
            }
            return { data: newSession };
          },
          after: async (newSession) => {
            await recordAuditEvent({ eventType: "identity.session.created", actor: "better-auth", personId: newSession.userId });
          },
        },
      },
    },
    plugins: [
      createGlobalLogout(db),
      jwt({ jwt: { issuer: config.AUTH_ISSUER } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "directory:access", "offline_access"],
        cachedResources: new Set([directoryAudience]),
        enforcePerClientResources: true,
        identifierValidator: (identifier) => identifier === directoryAudience,
        grantTypes: ["authorization_code", "refresh_token"],
        cachedTrustedClients: trustedClientIds,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        silenceWarnings: { oauthAuthServerConfig: true },
        clientPrivileges: () => false,
        accessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        customAccessTokenClaims: async ({ user: tokenUser, metadata, resources }) => {
          const clientId = typeof metadata?.clientId === "string" ? metadata.clientId : undefined;
          const targetsDirectory = resources?.length === 1 && resources[0] === directoryAudience;
          if (!targetsDirectory || !tokenUser?.id || !clientId || !(await hasLiveAppAccess(tokenUser.id, clientId))) {
            await recordAuditEvent({
              eventType: "oauth.token.denied",
              actor: "oauth-provider",
              personId: tokenUser?.id,
              clientId,
              detail: { reason: targetsDirectory ? "person_or_app_access_inactive" : "unexpected_resource" },
            });
            throw accessDenied("This person does not have active access to the requested application");
          }
          return {};
        },
      }),
    ],
  });

  return auth;
}
