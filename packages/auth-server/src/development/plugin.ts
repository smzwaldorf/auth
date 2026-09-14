import { createHash } from "node:crypto";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { RuntimeConfig as AuthConfig } from "../runtime-config.js";
import type { Database } from "../db/database.js";
import { account, personRoles, user, verification } from "../db/schema.js";
type LoginPolicy = { hasLiveAppAccess: (personId: string, clientId: string) => Promise<boolean> };
import { developmentIdentities, developmentLoginEnabled } from "./policy.js";

export function createDevelopmentLogin(config: AuthConfig, db: Database, { hasLiveAppAccess }: LoginPolicy, localDevelopmentRequests: WeakSet<Request>) {
return {
  id: "local-development-login",
  endpoints: {
    signInDevelopment: createAuthEndpoint("/sign-in/development", {
      method: "POST",
      metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"], noStore: true },
      body: z.object({ identity: z.enum(["admin", "parent", "schoolAdmin", "schoolTeacher"]), oauth_query: z.string().min(1) }).strict(),
    }, async (ctx) => {
      if (!developmentLoginEnabled(config) || !ctx.request || !localDevelopmentRequests.has(ctx.request)) throw new APIError("NOT_FOUND");
      // oauth-provider's before hook verifies the complete signed oauth_query;
      // its after hook resumes normal authorization after setSessionCookie.
      const identity = developmentIdentities[ctx.body.identity];
      const clientId = new URLSearchParams(ctx.body.oauth_query).get("client_id");
      const [synthetic] = await db.select().from(user).where(eq(user.id, identity.id));
      const roles = await db.select().from(personRoles).where(eq(personRoles.personId, identity.id));
      const links = await db.select({ id: account.id }).from(account).where(eq(account.userId, identity.id));
      if (!synthetic || synthetic.email !== identity.email || !synthetic.emailVerified || links.length ||
          roles.length !== 1 || roles[0]?.role !== identity.role || !clientId || !(await hasLiveAppAccess(identity.id, clientId))) {
        throw new APIError("FORBIDDEN", { error: "access_denied", message: "Development identity is not provisioned or no longer approved" });
      }
      const query = new URLSearchParams(ctx.body.oauth_query);
      const signature = query.get("sig");
      if (!signature) throw new APIError("BAD_REQUEST", { error: "invalid_signature" });
      const usedId = `development-login:${createHash("sha256").update(signature).digest("hex")}`;
      const used = await db.insert(verification).values({ id: usedId, identifier: usedId, value: "used", expiresAt: new Date(Number(query.get("exp")) * 1000) })
        .onConflictDoNothing().returning({ id: verification.id });
      if (!used.length) throw new APIError("BAD_REQUEST", { error: "login_context_already_used" });
      const previous = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true });
      const session = await ctx.context.internalAdapter.createSession(identity.id);
      if (!session) throw new APIError("FORBIDDEN", { error: "access_denied" });
      // Switching invalidates old app tokens through the central session binding.
      if (previous) await ctx.context.internalAdapter.deleteSession(previous.session.token);
      await setSessionCookie(ctx, { session, user: synthetic });
      return ctx.json({ success: true });
    }),
  },
};
}
