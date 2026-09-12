import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./db/database.js";
import { oauthAccessToken, oauthRefreshToken, session } from "./db/schema.js";

export function createGlobalLogout(db: Database) {
async function revokeCentralSession(sessionId: string) {
  // Delete grants before the session FK can null out their session_id.
  await db.transaction(async (tx) => {
    await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.sessionId, sessionId));
    await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.sessionId, sessionId));
    await tx.delete(session).where(eq(session.id, sessionId));
  });
}
return {
  id: "linked-application-logout",
  endpoints: {
    signOutLinkedApplications: createAuthEndpoint("/sign-out/linked-applications", {
      method: "POST", requireHeaders: true, metadata: { SERVER_ONLY: true },
    }, async (ctx) => {
      const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
      // A database failure must propagate; never claim logout succeeded on failure.
      const current = token ? await ctx.context.internalAdapter.findSession(token) : null;
      if (current) await revokeCentralSession(current.session.id);
      deleteSessionCookie(ctx);
      return ctx.json({ success: true });
    }),
  },
};
}

export async function hasLiveSession(db: Database, personId: string, sessionId: unknown): Promise<boolean> {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const [current] = await db.select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, personId), gt(session.expiresAt, new Date()))).limit(1);
  return Boolean(current);
}

/** Expiry is renewable/reauthentication state, not an explicit revocation. */
export async function centralSessionState(db: Database, personId: string, sessionId: unknown): Promise<"active" | "expired" | "revoked"> {
  if (typeof sessionId !== "string" || !sessionId) return "revoked";
  const [current] = await db.select({ expiresAt: session.expiresAt }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, personId))).limit(1);
  if (!current) return "revoked";
  const now = new Date();
  if (current.expiresAt <= now) return "expired";
  // At most one extension per day. This runs only after bearer signature/scope validation.
  // The conditional UPDATE cannot resurrect a concurrently deleted or expired session.
  if (current.expiresAt.getTime() < now.getTime() + 29 * 86400_000) {
    const updated = await db.update(session).set({ expiresAt: new Date(now.getTime() + 30 * 86400_000), updatedAt: now }).where(and(eq(session.id, sessionId), eq(session.userId, personId), gt(session.expiresAt, now))).returning({ id: session.id });
    if (!updated.length) return "revoked";
  }
  return "active";
}
