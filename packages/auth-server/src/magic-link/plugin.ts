import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db/database.js";
import { user, verification } from "../db/schema.js";
import { loginAllowed } from "../login-policy.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { normalizeEmail } from "../seed/model.js";
import { resendMailer, type LoginMailer } from "./mail.js";

// Persist throttles in Postgres so separate Worker instances share the limit.
async function throttle(db: Database, key: string, seconds: number) {
  const id = `magic-throttle:${createHash("sha256").update(key).digest("hex")}`;
  const now = new Date();
  const rows = await db.insert(verification).values({ id, identifier: id, value: "throttle", expiresAt: new Date(now.getTime() + seconds * 1000) })
    .onConflictDoUpdate({ target: verification.id, set: { expiresAt: new Date(now.getTime() + seconds * 1000) }, setWhere: lte(verification.expiresAt, now) }).returning({ id: verification.id });
  if (!rows.length) throw new APIError("TOO_MANY_REQUESTS", { message: "Please wait before requesting another link" });
}
async function limitIp(db: Database, ip: string | null, purpose: string, max: number) {
  if (!ip) return; // Hosted requests get Cloudflare's trusted CF-Connecting-IP.
  const bucket = Math.floor(Date.now() / 60000);
  const id = `magic-throttle:${createHash("sha256").update(`${purpose}:${ip}:${bucket}`).digest("hex")}`;
  const [row] = await db.insert(verification).values({ id, identifier: id, value: "1", expiresAt: new Date((bucket + 2) * 60000) })
    .onConflictDoUpdate({ target: verification.id, set: { value: sql`(${verification.value}::integer + 1)::text` } }).returning({ value: verification.value });
  if (!row || Number(row.value) > max) throw new APIError("TOO_MANY_REQUESTS");
}
export function magicLinkPlugins(config: RuntimeConfig, db: Database, mailer: LoginMailer = resendMailer(config)) {
  return [magicLink({ disableSignUp: true, expiresIn: 300, storeToken: "hashed", sendMagicLink: async ({ email, url }) => {
    try { await mailer({ email, url }); }
    catch { throw new APIError("SERVICE_UNAVAILABLE", { message: "Email delivery is temporarily unavailable. Please try again." }); }
  }}), {
    id: "smz-magic-link-policy",
    hooks: { before: [{ matcher: (ctx: { path?: string }) => ["/sign-in/email", "/sign-up/email", "/set-password", "/change-password", "/reset-password", "/request-password-reset", "/forget-password"].some(p => ctx.path === p || ctx.path?.startsWith(p + "/")), handler: createAuthMiddleware(async () => { throw new APIError("FORBIDDEN", { code: "PASSWORD_AUTH_DISABLED", message: "Password authentication is disabled" }); }) },
    { matcher: (ctx: { path?: string }) => ctx.path === "/magic-link/verify", handler: createAuthMiddleware(async ctx => {
      if (config.MAGIC_LINK_ENABLED !== "true") throw new APIError("NOT_FOUND");
      await limitIp(db, ctx.headers?.get("cf-connecting-ip") ?? null, "verify", 30);
      const token = typeof ctx.query?.token === "string" ? ctx.query.token : "";
      const hash = createHash("sha256").update(token).digest("base64url");
      const [record] = await db.select().from(verification).where(eq(verification.identifier, hash)).limit(1);
      if (record && record.expiresAt > new Date()) {
        const { email } = JSON.parse(record.value) as { email: string };
        const [candidate] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
        if (!candidate || !(await loginAllowed(db, config, candidate.id))) {
          await db.delete(verification).where(eq(verification.id, record.id));
          throw ctx.redirect(`${new URL(config.AUTH_ISSUER).origin}/magic-link/error`);
        }
      }
    }) }, { matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/magic-link", handler: createAuthMiddleware(async ctx => {
      if (config.MAGIC_LINK_ENABLED !== "true") throw new APIError("NOT_FOUND");
      if (!ctx.headers || ctx.headers.get("origin") !== new URL(config.AUTH_ISSUER).origin) throw new APIError("FORBIDDEN");
      await limitIp(db, ctx.headers.get("cf-connecting-ip"), "send", 10);
      const email = typeof ctx.body?.email === "string" ? normalizeEmail(ctx.body.email) : "";
      if (!email || email.length > 254 || !email.includes("@")) throw new APIError("BAD_REQUEST");
      await throttle(db, `email:${email}`, 60);
      const query = typeof ctx.body?.oauth_query === "string" ? ctx.body.oauth_query : "";
      if (!query || query.length > 8192 || !new URLSearchParams(query).has("sig")) throw new APIError("BAD_REQUEST", { message: "Start sign-in from an application" });
      // OAuth provider verifies oauth_query in its own before hook. Reauthorize
      // after redemption as a fallback when the email opens without its cookie.
      const continuation = new URLSearchParams(query);
      for (const key of ["sig", "exp", "ba_iat", "ba_pl", "max_age"]) continuation.delete(key);
      const prompt = (continuation.get("prompt") || "").split(" ").filter(p => p && p !== "login").join(" ");
      if (prompt) continuation.set("prompt", prompt); else continuation.delete("prompt");
      ctx.body.email = email;
      ctx.body.callbackURL = `${config.AUTH_ISSUER}/oauth2/authorize?${continuation}`;
      ctx.body.errorCallbackURL = `${new URL(config.AUTH_ISSUER).origin}/magic-link/error`;
      delete ctx.body.newUserCallbackURL;
      const [candidate] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
      if (!candidate || !(await loginAllowed(db, config, candidate.id))) return ctx.json({ status: true });
    }) }] },
  }];
}
