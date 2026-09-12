import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import * as oauth from "openid-client";
import type { AppConfig } from "./config.js";
import type { AccessContext } from "./types.js";
import { CookieSession, COOKIE_CHUNK_SIZE, MAX_COOKIE_CHUNKS } from "./session.js";
import { page } from "./page.js";

export function createApp(settings: AppConfig) {
  const app = new Hono<{ Variables: { session: CookieSession } }>();
  const issuer = new URL(settings.AUTH_ISSUER);
  const resource = `${issuer.origin}/api/directory/v1`;
  const cookieName = settings.production ? "__Host-smz-app-b" : "smz.app-b";
  let discovery: Promise<oauth.Configuration> | undefined;
  function configuration() {
    discovery ??= oauth.discovery(issuer, "express-app", settings.APP_B_CLIENT_SECRET, undefined, {
      execute: !settings.production && issuer.hostname === "localhost" ? [oauth.allowInsecureRequests] : [],
    });
    return discovery;
  }
  app.use("*", secureHeaders({ xFrameOptions: false }));
  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", `frame-ancestors ${c.req.path === "/logout/local" ? issuer.origin : "\'none\'"}`);
    if (c.req.path !== "/logout/local") c.header("X-Frame-Options", "DENY");
    await next();
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.path === "/health") return next();
    const session = new CookieSession(settings.APP_B_COOKIE_SECRET);
    const names = Array.from({ length: MAX_COOKIE_CHUNKS }, (_, i) => `${cookieName}.${i}`);
    await session.load(names.map(name => getCookie(c, name) ?? "").join(""));
    c.set("session", session);
    await next();
    if (c.error) return;
    const saved = await session.save();
    const options = { httpOnly: true, secure: settings.production, sameSite: "Lax" as const, path: "/" };
    if (saved.token || saved.cleared) {
      deleteCookie(c, cookieName, options);
      for (const [i, name] of names.entries()) {
        const chunk = saved.token?.slice(i * COOKIE_CHUNK_SIZE, (i + 1) * COOKIE_CHUNK_SIZE);
        if (chunk) setCookie(c, name, chunk, { ...options, maxAge: saved.maxAge });
        else deleteCookie(c, name, options);
      }
    }
  });
  async function access(session: CookieSession): Promise<{ context?: AccessContext; error?: string; status?: number }> {
    const request = (token: string) => fetch(`${resource}/me/access-context`, { headers: { Authorization: `Bearer ${token}` } });
    if (!session.data.accessToken) return { error: "missing_access_token", status: 401 };
    let response = await request(session.data.accessToken);
    if (response.status === 401 && session.data.refreshToken) {
      const tokens = await oauth.refreshTokenGrant(await configuration(), session.data.refreshToken, { resource });
      session.data.accessToken = tokens.access_token;
      session.data.refreshToken = tokens.refresh_token ?? session.data.refreshToken;
      session.touch();
      response = await request(tokens.access_token);
    }
    if (!response.ok) return { error: "directory_access_unavailable", status: response.status };
    return { context: await response.json() as AccessContext };
  }
  async function clear(session: CookieSession) {
    try {
      if (session.data.accessToken || session.data.refreshToken) {
        const config = await configuration();
        await Promise.allSettled([
          ...(session.data.accessToken ? [oauth.tokenRevocation(config, session.data.accessToken, { token_type_hint: "access_token" })] : []),
          ...(session.data.refreshToken ? [oauth.tokenRevocation(config, session.data.refreshToken, { token_type_hint: "refresh_token" })] : []),
        ]);
      }
    } catch { /* Always remove the local session, including during an IdP outage. */ }
    await session.destroy();
  }
  app.get("/health", (c) => c.json({ ok: true, storage: "encrypted-cookie" }));
  app.get("/", async (c) => {
    const session = c.get("session");
    const result = session.data.user ? await access(session) : {};
    return c.html(page(settings.AUTH_ISSUER, settings.APP_A_ORIGIN, session.data.user, result.context, result.error));
  });
  app.get("/login", async (c) => {
    const config = await configuration();
    const session = c.get("session");
    await session.rotate();
    const codeVerifier = oauth.randomPKCECodeVerifier();
    const state = oauth.randomState();
    const nonce = oauth.randomNonce();
    session.data.oidcFlow = { codeVerifier, state, nonce };
    return c.redirect(oauth.buildAuthorizationUrl(config, {
      redirect_uri: `${settings.APP_B_ORIGIN}/auth/callback`, response_type: "code",
      scope: "openid profile email directory:access offline_access", resource,
      code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: "S256", state, nonce,
    }).href);
  });
  app.get("/auth/callback", async (c) => {
    const session = c.get("session");
    const flow = session.data.oidcFlow;
    if (!flow) return c.json({ error: "login_session_expired" }, 400);
    const config = await configuration();
    const callback = new URL(new URL(c.req.url).pathname + new URL(c.req.url).search, settings.APP_B_ORIGIN);
    const tokens = await oauth.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: flow.codeVerifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
    }, { resource });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("Missing subject claim");
    const info = await oauth.fetchUserInfo(config, tokens.access_token, claims.sub);
    await session.rotate();
    session.data = {
      user: { sub: claims.sub, iss: claims.iss, name: typeof info.name === "string" ? info.name : undefined, email: typeof info.email === "string" ? info.email : undefined, picture: typeof info.picture === "string" ? info.picture : undefined },
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    };
    return c.redirect("/");
  });
  app.get("/protected", async (c) => {
    const session = c.get("session");
    if (!session.data.user) return c.redirect("/login");
    const result = await access(session);
    if (!result.context) return c.json({ error: result.error }, result.status && result.status >= 500 ? 503 : 403);
    return c.json({ message: "You reached a protected route.", user: session.data.user, accessContext: result.context });
  });
  app.get("/logout", async (c) => { await clear(c.get("session")); return c.redirect(`${issuer.origin}/logout-all/app-b`); });
  app.get("/logout/local", async (c) => {
    const state = c.req.query("logout_state");
    let parentOrigin: string | undefined;
    try { parentOrigin = new URL(c.req.header("referer") ?? "").origin; } catch { /* Reject missing or malformed parent. */ }
    if (parentOrigin !== issuer.origin || !state || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state)) return c.json({ error: "invalid_logout_context" }, 400);
    await c.get("session").destroy();
    return c.html(`<!doctype html><html><head><title>Signed out</title></head><body><p>Local session cleared.</p><script>if(window.parent!==window){const channel=new BroadcastChannel("smz-global-logout");channel.postMessage("logout");channel.close();window.parent.postMessage({type:"smz:logout-complete",state:${JSON.stringify(state)}},${JSON.stringify(issuer.origin)});}</script></body></html>`);
  });
  app.onError((error, c) => { console.error(error); return c.json({ error: "application_unavailable" }, 503); });
  return app;
}
