import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { magicLink } from "better-auth/plugins/magic-link";

import { recordAuditEvent } from "./audit.js";
import { config, developmentLoginEnabled, directoryAudience, trustedBrowserOrigins, trustedClientIds } from "./config.js";
import { db } from "./db/client.js";
import { developmentLoginAccounts, loginInvitations, people, personRoles, user } from "./db/schema.js";
import * as schema from "./db/schema.js";
import { hasLiveAppAccess } from "./directory/access-context.js";
import { normalizeEmail } from "./seed/model.js";

type DirectoryRole = "admin" | "teacher" | "parent" | "student";

const applicationLoginRoles = ["parent", "teacher"] as const satisfies readonly DirectoryRole[];
const authenticationRoles = [...applicationLoginRoles, "admin"] as const;
const adminRoles = ["admin"] as const;

type DevelopmentMagicLinkWaiter = {
  resolve: (url: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const developmentMagicLinkWaiters = new Map<string, DevelopmentMagicLinkWaiter>();

function hasEligibleRole(role: string, roles: readonly DirectoryRole[]): boolean {
  return (roles as readonly string[]).includes(role);
}

export function isEligibleLoginPerson(input: { kind: "adult" | "student"; status: "active" | "disabled"; roles: string[] }): boolean {
  return input.kind === "adult" && input.status === "active" && input.roles.some((role) => hasEligibleRole(role, applicationLoginRoles));
}

export function isEligibleAuthenticationPerson(input: { kind: "adult" | "student"; status: "active" | "disabled"; roles: string[] }): boolean {
  return input.kind === "adult" && input.status === "active" && input.roles.some((role) => hasEligibleRole(role, authenticationRoles));
}

async function activeInvitationForUserWithRoles(userId: string, eligibleRoles: readonly DirectoryRole[]) {
  const now = new Date();
  const [row] = await db
    .select({
      invitationId: loginInvitations.id,
      invitationEmail: loginInvitations.normalizedEmail,
      personEmail: people.normalizedLoginEmail,
      authEmail: user.email,
      personStatus: people.status,
      personKind: people.kind,
      role: personRoles.role,
    })
    .from(loginInvitations)
    .innerJoin(people, eq(people.id, loginInvitations.personId))
    .innerJoin(user, sql`${user.id} = ${loginInvitations.personId}::text`)
    .innerJoin(personRoles, eq(personRoles.personId, people.id))
    .where(
      and(
        eq(loginInvitations.personId, userId),
        inArray(personRoles.role, eligibleRoles),
        inArray(loginInvitations.status, ["pending", "activated"]),
        or(isNull(loginInvitations.expiresAt), gt(loginInvitations.expiresAt, now)),
      ),
    )
    .limit(1);
  return row && isEligibleAuthenticationPerson({ kind: row.personKind, status: row.personStatus, roles: [row.role] }) &&
    row.invitationEmail === row.personEmail &&
    row.invitationEmail === normalizeEmail(row.authEmail)
    ? row
    : null;
}

export async function activeInvitationForUser(userId: string) {
  return activeInvitationForUserWithRoles(userId, authenticationRoles);
}

export async function activeAdminForUser(userId: string) {
  return activeInvitationForUserWithRoles(userId, adminRoles);
}

async function activeInvitationForEmailWithRoles(email: string, eligibleRoles: readonly DirectoryRole[]) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();
  const [row] = await db
    .select({
      personId: people.id,
      displayName: people.displayName,
      personStatus: people.status,
      personKind: people.kind,
      role: personRoles.role,
      invitationStatus: loginInvitations.status,
      invitationEmail: loginInvitations.normalizedEmail,
      personEmail: people.normalizedLoginEmail,
      authEmail: user.email,
    })
    .from(people)
    .innerJoin(loginInvitations, eq(loginInvitations.personId, people.id))
    .innerJoin(user, sql`${user.id} = ${people.id}::text`)
    .innerJoin(personRoles, eq(personRoles.personId, people.id))
    .where(
      and(
        eq(people.normalizedLoginEmail, normalizedEmail),
        inArray(personRoles.role, eligibleRoles),
        inArray(loginInvitations.status, ["pending", "activated"]),
        or(isNull(loginInvitations.expiresAt), gt(loginInvitations.expiresAt, now)),
      ),
    )
    .limit(1);
  return row && isEligibleAuthenticationPerson({ kind: row.personKind, status: row.personStatus, roles: [row.role] }) &&
    row.invitationEmail === normalizedEmail &&
    row.personEmail === normalizedEmail &&
    normalizeEmail(row.authEmail) === normalizedEmail
    ? row
    : null;
}

export async function activeInvitationForEmail(email: string) {
  return activeInvitationForEmailWithRoles(email, applicationLoginRoles);
}

export async function activeAdminInvitationForEmail(email: string) {
  return activeInvitationForEmailWithRoles(email, adminRoles);
}

export async function activeDevelopmentLoginForUser(userId: string) {
  if (!developmentLoginEnabled) return null;
  const [row] = await db
    .select({ personId: developmentLoginAccounts.personId, label: developmentLoginAccounts.label })
    .from(developmentLoginAccounts)
    .where(and(eq(developmentLoginAccounts.personId, userId), eq(developmentLoginAccounts.enabled, true)))
    .limit(1);
  return row && await activeInvitationForUser(row.personId) ? row : null;
}

export async function listActiveDevelopmentLogins() {
  if (!developmentLoginEnabled) return [];
  const rows = await db
    .select({ personId: developmentLoginAccounts.personId, label: developmentLoginAccounts.label })
    .from(developmentLoginAccounts)
    .where(eq(developmentLoginAccounts.enabled, true));
  const eligible = await Promise.all(rows.map(async (row) => (await activeInvitationForUser(row.personId)) ? row : null));
  return eligible.filter((row): row is { personId: string; label: string } => Boolean(row));
}

export function waitForDevelopmentMagicLink(requestId: string): Promise<string> {
  if (!developmentLoginEnabled) return Promise.reject(new Error("Development login is disabled"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      developmentMagicLinkWaiters.delete(requestId);
      reject(new Error("Development login link was not created"));
    }, 2_000);
    developmentMagicLinkWaiters.set(requestId, { resolve, reject, timeout });
  });
}

export function cancelDevelopmentMagicLink(requestId: string): void {
  const waiter = developmentMagicLinkWaiters.get(requestId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  developmentMagicLinkWaiters.delete(requestId);
  waiter.reject(new Error("Development login cancelled"));
}

async function sendMagicLink(input: { email: string; url: string; metadata?: Record<string, unknown> }): Promise<void> {
  const requestId = typeof input.metadata?.developmentLoginRequestId === "string"
    ? input.metadata.developmentLoginRequestId
    : undefined;
  const developmentWaiter = requestId ? developmentMagicLinkWaiters.get(requestId) : undefined;
  if (developmentWaiter) {
    clearTimeout(developmentWaiter.timeout);
    developmentMagicLinkWaiters.delete(requestId!);
    developmentWaiter.resolve(input.url);
    return;
  }

  if (config.NODE_ENV !== "production") {
    console.info(`[smz-auth] Magic link for ${normalizeEmail(input.email)}: ${input.url}`);
    return;
  }
  if (!config.MAGIC_LINK_DELIVERY_WEBHOOK_URL) {
    throw new Error("MAGIC_LINK_DELIVERY_WEBHOOK_URL must be configured in production");
  }
  const response = await fetch(config.MAGIC_LINK_DELIVERY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.MAGIC_LINK_DELIVERY_WEBHOOK_TOKEN ? { authorization: `Bearer ${config.MAGIC_LINK_DELIVERY_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ to: normalizeEmail(input.email), magicLinkUrl: input.url }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Magic-link delivery failed (${response.status})`);
}

function accessDenied(message: string): APIError {
  return new APIError("FORBIDDEN", { message, error: "access_denied" });
}

export const auth = betterAuth({
  appName: "SMZ Identity",
  baseURL: config.AUTH_ISSUER,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [...trustedBrowserOrigins],
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
      // Directory adults are pre-provisioned in auth.user. Let Better Auth
      // perform the first exact-email Google account link; the user and
      // account database hooks below remain the policy gate for unknown or
      // inactive people. Better Auth's disableSignUp flags can otherwise
      // reject that initial link as `signup_disabled` before the hooks run.
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
          if (!(await activeInvitationForUser(newSession.userId))) {
            await recordAuditEvent({ eventType: "identity.login.denied", actor: "better-auth", personId: newSession.userId, detail: { reason: "person_inactive_or_unsupported_role" } });
            throw accessDenied("Only active parents, teachers, and administrators can authenticate");
          }
          return { data: newSession };
        },
        after: async (newSession) => {
          const now = new Date();
          await db
            .update(loginInvitations)
            .set({ status: "activated", activatedAt: now, updatedAt: now })
            .where(eq(loginInvitations.personId, newSession.userId));
          await recordAuditEvent({ eventType: "identity.session.created", actor: "better-auth", personId: newSession.userId });
        },
      },
    },
  },
  plugins: [
    jwt({ jwt: { issuer: config.AUTH_ISSUER } }),
    magicLink({
      disableSignUp: true,
      expiresIn: 10 * 60,
      storeToken: "hashed",
      sendMagicLink,
    }),
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

export const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
