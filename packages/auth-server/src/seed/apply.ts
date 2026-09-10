import { createHash } from "node:crypto";
import process from "node:process";

import { and, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { config, directoryAudience } from "../config.js";
import {
  account,
  appAccess,
  applications,
  auditEvents,
  classMemberships,
  classes,
  families,
  familyMemberships,
  loginInvitations,
  oauthAccessToken,
  oauthClient,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  people,
  personRoles,
  session,
  user,
} from "../db/schema.js";
import { normalizeEmail, type DirectorySeed } from "./model.js";

function hashClientSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function seedAuditId(seed: DirectorySeed): string {
  const hex = createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function applyDirectorySeed(seed: DirectorySeed): Promise<void> {
  const now = new Date();
  const seededPersonIds = seed.people.map((person) => person.id);

  await db.transaction(async (tx) => {
    const previousAccess = seededPersonIds.length
      ? await tx.select().from(appAccess).where(inArray(appAccess.personId, seededPersonIds))
      : [];

    for (const person of seed.people) {
      const normalizedLoginEmail = person.loginEmail ? normalizeEmail(person.loginEmail) : null;
      await tx
        .insert(people)
        .values({
          id: person.id,
          kind: person.kind,
          displayName: person.displayName,
          normalizedLoginEmail,
          status: person.status,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: people.id,
          set: { kind: person.kind, displayName: person.displayName, normalizedLoginEmail, status: person.status, updatedAt: now },
        });

      if (person.kind === "adult" && normalizedLoginEmail && person.invitation) {
        await tx
          .insert(user)
          .values({ id: person.id, name: person.displayName, email: normalizedLoginEmail, emailVerified: person.invitation.status === "activated", updatedAt: now })
          .onConflictDoUpdate({ target: user.id, set: { name: person.displayName, email: normalizedLoginEmail, updatedAt: now } });

        await tx
          .insert(loginInvitations)
          .values({
            id: person.invitation.id,
            personId: person.id,
            normalizedEmail: normalizedLoginEmail,
            status: person.invitation.status,
            expiresAt: person.invitation.expiresAt ? new Date(person.invitation.expiresAt) : null,
            activatedAt: person.invitation.status === "activated" ? now : null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: loginInvitations.id,
            set: {
              personId: person.id,
              normalizedEmail: normalizedLoginEmail,
              status: person.invitation.status,
              expiresAt: person.invitation.expiresAt ? new Date(person.invitation.expiresAt) : null,
              updatedAt: now,
            },
          });
      }
    }

    for (const person of seed.people) {
      await tx
        .delete(personRoles)
        .where(and(eq(personRoles.personId, person.id), notInArray(personRoles.role, person.roles)));
      await tx
        .insert(personRoles)
        .values(person.roles.map((role) => ({ personId: person.id, role })))
        .onConflictDoNothing();
    }

    for (const family of seed.families) {
      await tx
        .insert(families)
        .values({ id: family.id, code: family.code, displayName: family.displayName, status: family.status, updatedAt: now })
        .onConflictDoUpdate({ target: families.id, set: { code: family.code, displayName: family.displayName, status: family.status, updatedAt: now } });
    }
    for (const family of seed.families) {
      const membershipIds = family.memberships.map((membership) => membership.id);
      if (membershipIds.length) {
        await tx.delete(familyMemberships).where(and(eq(familyMemberships.familyId, family.id), notInArray(familyMemberships.id, membershipIds)));
      } else await tx.delete(familyMemberships).where(eq(familyMemberships.familyId, family.id));
      for (const membership of family.memberships) {
        await tx
          .insert(familyMemberships)
          .values({ ...membership, familyId: family.id, startsOn: membership.startsOn ?? null, endsOn: membership.endsOn ?? null, updatedAt: now })
          .onConflictDoUpdate({
            target: familyMemberships.id,
            set: {
              familyId: family.id,
              personId: membership.personId,
              relationship: membership.relationship,
              status: membership.status,
              startsOn: membership.startsOn ?? null,
              endsOn: membership.endsOn ?? null,
              updatedAt: now,
            },
          });
      }
    }

    for (const schoolClass of seed.classes) {
      await tx
        .insert(classes)
        .values({ id: schoolClass.id, code: schoolClass.code, displayName: schoolClass.displayName, status: schoolClass.status, updatedAt: now })
        .onConflictDoUpdate({ target: classes.id, set: { code: schoolClass.code, displayName: schoolClass.displayName, status: schoolClass.status, updatedAt: now } });
    }
    for (const schoolClass of seed.classes) {
      const membershipIds = schoolClass.memberships.map((membership) => membership.id);
      if (membershipIds.length) {
        await tx.delete(classMemberships).where(and(eq(classMemberships.classId, schoolClass.id), notInArray(classMemberships.id, membershipIds)));
      } else await tx.delete(classMemberships).where(eq(classMemberships.classId, schoolClass.id));
      for (const membership of schoolClass.memberships) {
        await tx
          .insert(classMemberships)
          .values({ ...membership, classId: schoolClass.id, startsOn: membership.startsOn ?? null, endsOn: membership.endsOn ?? null, updatedAt: now })
          .onConflictDoUpdate({
            target: classMemberships.id,
            set: {
              classId: schoolClass.id,
              personId: membership.personId,
              relationship: membership.relationship,
              status: membership.status,
              startsOn: membership.startsOn ?? null,
              endsOn: membership.endsOn ?? null,
              updatedAt: now,
            },
          });
      }
    }

    await tx
      .insert(oauthResource)
      .values({
        id: `resource:${directoryAudience}`,
        identifier: directoryAudience,
        name: "SMZ Directory API",
        accessTokenTtl: 15 * 60,
        refreshTokenTtl: 30 * 24 * 60 * 60,
        // Better Auth applies this list as an intersection, so it must retain
        // the OIDC scopes as well as the directory API permission. Otherwise
        // `openid` is stripped and no ID token can be issued.
        allowedScopes: ["openid", "profile", "email", "directory:access", "offline_access"],
        dpopBoundAccessTokensRequired: false,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthResource.identifier,
        set: {
          name: "SMZ Directory API",
          accessTokenTtl: 15 * 60,
          refreshTokenTtl: 30 * 24 * 60 * 60,
          allowedScopes: ["openid", "profile", "email", "directory:access", "offline_access"],
          disabled: false,
          updatedAt: now,
        },
      });

    for (const application of seed.applications) {
      const rawSecret = application.clientSecretEnv
        ? process.env[application.clientSecretEnv] ?? (application.clientSecretEnv === "APP_B_CLIENT_SECRET" ? config.APP_B_CLIENT_SECRET : undefined)
        : undefined;
      if (application.clientType === "confidential" && !rawSecret) {
        throw new Error(`Missing ${application.clientSecretEnv} for confidential client ${application.clientId}`);
      }
      const clientSecret = rawSecret ? hashClientSecret(rawSecret) : null;
      await tx
        .insert(oauthClient)
        .values({
          id: `client:${application.clientId}`,
          clientId: application.clientId,
          clientSecret,
          disabled: !application.enabled,
          skipConsent: true,
          enableEndSession: true,
          scopes: application.scopes,
          createdAt: now,
          updatedAt: now,
          name: application.displayName,
          redirectUris: application.redirectUris,
          postLogoutRedirectUris: application.postLogoutRedirectUris,
          tokenEndpointAuthMethod: application.clientType === "public" ? "none" : "client_secret_post",
          applicationType: "web",
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          public: application.clientType === "public",
          type: "web",
          requirePKCE: true,
          metadata: { clientId: application.clientId },
        })
        .onConflictDoUpdate({
          target: oauthClient.clientId,
          set: {
            clientSecret,
            disabled: !application.enabled,
            skipConsent: true,
            enableEndSession: true,
            scopes: application.scopes,
            updatedAt: now,
            name: application.displayName,
            redirectUris: application.redirectUris,
            postLogoutRedirectUris: application.postLogoutRedirectUris,
            tokenEndpointAuthMethod: application.clientType === "public" ? "none" : "client_secret_post",
            applicationType: "web",
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            public: application.clientType === "public",
            type: "web",
            requirePKCE: true,
            metadata: { clientId: application.clientId },
          },
        });

      if (application.scopes.includes("directory:access")) {
        await tx
          .insert(oauthClientResource)
          .values({
            id: `client-resource:${application.clientId}:${directoryAudience}`,
            clientId: application.clientId,
            resourceId: directoryAudience,
            createdAt: now,
          })
          .onConflictDoNothing();
      } else {
        await tx
          .delete(oauthClientResource)
          .where(and(eq(oauthClientResource.clientId, application.clientId), eq(oauthClientResource.resourceId, directoryAudience)));
      }

      await tx
        .insert(applications)
        .values({ clientId: application.clientId, displayName: application.displayName, publicOrigin: application.publicOrigin ?? null, enabled: application.enabled, updatedAt: now })
        .onConflictDoUpdate({
          target: applications.clientId,
          set: { displayName: application.displayName, publicOrigin: application.publicOrigin ?? null, enabled: application.enabled, updatedAt: now },
        });
    }

    for (const personId of seededPersonIds) {
      const desired = seed.appAccess.filter((access) => access.personId === personId);
      if (desired.length) {
        await tx.delete(appAccess).where(and(eq(appAccess.personId, personId), notInArray(appAccess.clientId, desired.map((access) => access.clientId))));
      } else await tx.delete(appAccess).where(eq(appAccess.personId, personId));
      for (const access of desired) {
        await tx
          .insert(appAccess)
          .values({ ...access, updatedAt: now })
          .onConflictDoUpdate({ target: [appAccess.personId, appAccess.clientId], set: { status: access.status, updatedAt: now } });
      }
    }

    const activePairs = new Set(seed.appAccess.filter((access) => access.status === "active").map((access) => `${access.personId}:${access.clientId}`));
    const revokedPairs = new Set([
      ...previousAccess.filter((access) => !activePairs.has(`${access.personId}:${access.clientId}`)).map((access) => `${access.personId}:${access.clientId}`),
      ...seed.appAccess.filter((access) => access.status === "revoked").map((access) => `${access.personId}:${access.clientId}`),
    ]);
    for (const pair of revokedPairs) {
      const separator = pair.lastIndexOf(":");
      const personId = pair.slice(0, separator);
      const clientId = pair.slice(separator + 1);
      await tx.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, personId), eq(oauthAccessToken.clientId, clientId)));
      await tx.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.userId, personId), eq(oauthRefreshToken.clientId, clientId)));
      await tx.delete(oauthConsent).where(and(eq(oauthConsent.userId, personId), eq(oauthConsent.clientId, clientId)));
    }

    const disabledPersonIds = seed.people.filter((person) => person.status === "disabled").map((person) => person.id);
    if (disabledPersonIds.length) {
      await tx.delete(session).where(inArray(session.userId, disabledPersonIds));
      await tx.delete(oauthAccessToken).where(inArray(oauthAccessToken.userId, disabledPersonIds));
      await tx.delete(oauthRefreshToken).where(inArray(oauthRefreshToken.userId, disabledPersonIds));
      await tx.delete(oauthConsent).where(inArray(oauthConsent.userId, disabledPersonIds));
      await tx.delete(account).where(and(inArray(account.userId, disabledPersonIds), eq(account.providerId, "google")));
    }

    await tx
      .insert(auditEvents)
      .values({ id: seedAuditId(seed), eventType: "directory.seed.applied", actor: "directory:seed", detail: { ...seed.school } })
      .onConflictDoNothing();
  });
}
