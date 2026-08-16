import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import * as oauth from "openid-client";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const issuer = new URL(process.env.AUTH_ISSUER ?? "http://localhost:3000/api/auth");
const clientId = "express-app";
const clientSecret = process.env.APP_B_CLIENT_SECRET ?? "local-app-b-client-secret-change-me";
const redirectUri = "http://localhost:4000/auth/callback";

type AuthUser = {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  iss?: string;
};

type AccessContext = {
  sub: string;
  clientId: string;
  access: "active";
  roles: string[];
  classScopes: { parent: string[]; teacher: string[]; effective: string[] };
};

declare module "express-session" {
  interface SessionData {
    oidcFlow?: { codeVerifier: string; state: string; nonce: string };
    user?: AuthUser;
    idToken?: string;
    accessToken?: string;
    refreshToken?: string;
  }
}

let configurationPromise: Promise<oauth.Configuration> | undefined;
function configuration(): Promise<oauth.Configuration> {
  configurationPromise ??= oauth.discovery(issuer, clientId, clientSecret, undefined, {
    // openid-client intentionally requires HTTPS; this exception is localhost-only.
    execute: issuer.hostname === "localhost" ? [oauth.allowInsecureRequests] : [],
  });
  return configurationPromise;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] ?? character);
}

function page(user?: AuthUser, accessContext?: AccessContext, accessError?: string): string {
  const authenticated = Boolean(user);
  const signedIn = Boolean(user && accessContext?.access === "active");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Express App B · SMZ Auth</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #211b17; background: #f4eee9; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; padding: 32px 20px; background: radial-gradient(circle at 10% 0%, #f3dfd0, transparent 36%), #f4eee9; }
      main { width: min(100%, 720px); margin: 5vh auto 0; padding: 34px; border: 1px solid #e3d8cf; border-radius: 26px; background: rgba(255,255,255,.9); box-shadow: 0 28px 80px rgba(72,43,27,.12); }
      header { display: flex; align-items: center; gap: 15px; }
      .mark { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 16px; color: white; font-size: 23px; font-weight: 800; background: #a34f32; }
      h1, h2, p { margin-top: 0; } h1 { margin-bottom: 0; font-size: 27px; letter-spacing: -.04em; }
      .eyebrow { display: block; margin-bottom: 3px; color: #8c7669; font-size: 12px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
      .status { display: flex; align-items: center; gap: 12px; margin: 30px 0; padding: 16px 18px; border-radius: 14px; color: ${signedIn ? "#165c3a" : "#6f5630"}; background: ${signedIn ? "#e4f3e9" : "#f5eee2"}; }
      .dot { width: 11px; height: 11px; border-radius: 50%; background: ${signedIn ? "#1f8a55" : "#bd8331"}; box-shadow: 0 0 0 5px ${signedIn ? "rgba(31,138,85,.12)" : "rgba(189,131,49,.12)"}; }
      .status strong { display: block; font-size: 18px; }
      .panel { padding: 24px; border: 1px solid #eadfd8; border-radius: 16px; background: #fcfaf8; }
      .panel p { margin-bottom: 0; color: #796c64; line-height: 1.6; }
      dl { display: grid; gap: 1px; margin: 24px 0 0; overflow: hidden; border: 1px solid #eadfd8; border-radius: 14px; background: #eadfd8; }
      dl div { display: grid; grid-template-columns: 130px 1fr; padding: 12px 14px; background: white; }
      dt { color: #8c7669; font-size: 13px; } dd { margin: 0; overflow-wrap: anywhere; font: 13px ui-monospace, monospace; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
      .actions a { min-height: 46px; padding: 12px 17px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: white; background: #a34f32; text-decoration: none; font-weight: 750; }
      .actions a.secondary { color: #5e4437; border: 1px solid #dfd2ca; background: white; }
      @media (max-width: 560px) { main { padding: 24px; } dl div { grid-template-columns: 1fr; gap: 5px; } .actions a { width: 100%; } }
    </style>
  </head>
  <body>
    <main>
      <header><div class="mark">B</div><div><span class="eyebrow">Confidential OIDC client</span><h1>Express App B</h1></div></header>
      <section class="status"><div class="dot"></div><div><span class="eyebrow">Authentication status</span><strong>${signedIn ? "Authenticated" : "Not authenticated"}</strong></div></section>
      ${user ? `
        <section class="panel"><h2>${escapeHtml(user.name ?? "Signed-in user")}</h2><p>${escapeHtml(user.email ?? "No email claim")}</p></section>
        <dl>
          <div><dt>Issuer</dt><dd>${escapeHtml(user.iss ?? issuer.href)}</dd></div>
          <div><dt>Subject</dt><dd>${escapeHtml(user.sub)}</dd></div>
          <div><dt>Client ID</dt><dd>express-app</dd></div>
          <div><dt>Session</dt><dd>Server-side application session</dd></div>
          <div><dt>Directory access</dt><dd>${escapeHtml(accessContext?.access ?? accessError ?? "unavailable")}</dd></div>
          <div><dt>School roles</dt><dd>${escapeHtml(accessContext?.roles.join(", ") || "none")}</dd></div>
          <div><dt>Class scopes</dt><dd>${escapeHtml(accessContext?.classScopes.effective.join(", ") || "none")}</dd></div>
        </dl>` : `
        <section class="panel"><h2>Server-side authentication</h2><p>The authorization code is redeemed on this Express server. Browser requests then use an application session cookie.</p></section>`}
      <div class="actions">
        <a href="${authenticated ? "/logout" : "/login"}">${authenticated ? "Sign out" : "Sign in through SMZ Auth"}</a>
        <a class="secondary" href="http://localhost:5173">Open Vite App A ↗</a>
        ${signedIn ? '<a class="secondary" href="/protected">Open protected route</a>' : ""}
      </div>
      <script>
        const globalLogoutChannel = new BroadcastChannel("smz-global-logout");
        globalLogoutChannel.addEventListener("message", () => window.location.reload());
      </script>
    </main>
  </body>
</html>`;
}

const app = express();
app.set("trust proxy", 1);
app.use(
  session({
    name: "smz.app-b",
    secret: process.env.APP_B_COOKIE_SECRET ?? "local-app-b-cookie-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 60 * 60 * 1000 },
  }),
);

async function fetchAccessContext(req: Request): Promise<{ context?: AccessContext; error?: string }> {
  async function request(accessToken: string) {
    return fetch("http://localhost:3000/api/directory/v1/me/access-context", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!req.session.accessToken) return { error: "missing access token" };
  let response = await request(req.session.accessToken);
  if (response.status === 401 && req.session.refreshToken) {
    const config = await configuration();
    const refreshed = await oauth.refreshTokenGrant(config, req.session.refreshToken, { resource: "smz-directory" });
    req.session.accessToken = refreshed.access_token;
    req.session.refreshToken = refreshed.refresh_token ?? req.session.refreshToken;
    req.session.idToken = refreshed.id_token ?? req.session.idToken;
    response = await request(refreshed.access_token);
  }
  if (!response.ok) return { error: `directory denied access (${response.status})` };
  return { context: await response.json() as AccessContext };
}

async function clearLocalSession(req: Request): Promise<void> {
  const accessToken = req.session.accessToken;
  const refreshToken = req.session.refreshToken;
  try {
    const config = await configuration();
    const revocations: Array<Promise<void>> = [];
    if (accessToken) revocations.push(oauth.tokenRevocation(config, accessToken, { token_type_hint: "access_token" }));
    if (refreshToken) revocations.push(oauth.tokenRevocation(config, refreshToken, { token_type_hint: "refresh_token" }));
    await Promise.allSettled(revocations);
  } catch {
    // Local session cleanup must still complete if a token is already invalid
    // or the identity service is temporarily unavailable.
  } finally {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  }
}

app.get("/", async (req, res, next) => {
  try {
    const access = req.session.user ? await fetchAccessContext(req) : {};
    res.type("html").send(page(req.session.user, access.context, access.error));
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, issuer: issuer.href }));

app.get("/login", async (req, res, next) => {
  try {
    const config = await configuration();
    const codeVerifier = oauth.randomPKCECodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const state = oauth.randomState();
    const nonce = oauth.randomNonce();
    req.session.oidcFlow = { codeVerifier, state, nonce };
    const destination = oauth.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email directory:access offline_access",
      resource: "smz-directory",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    res.redirect(destination.href);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/callback", async (req, res, next) => {
  try {
    const flow = req.session.oidcFlow;
    if (!flow) throw new Error("Login session expired");
    const config = await configuration();
    const currentUrl = new URL(req.originalUrl, "http://localhost:4000");
    const tokens = await oauth.authorizationCodeGrant(
      config,
      currentUrl,
      {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      },
      { resource: "smz-directory" },
    );
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error("No subject claim returned by auth server");
    const userInfo = await oauth.fetchUserInfo(config, tokens.access_token, claims.sub);
    req.session.user = {
      sub: claims.sub,
      name: typeof userInfo.name === "string" ? userInfo.name : undefined,
      email: typeof userInfo.email === "string" ? userInfo.email : undefined,
      picture: typeof userInfo.picture === "string" ? userInfo.picture : undefined,
      iss: claims.iss,
    };
    req.session.idToken = tokens.id_token;
    req.session.accessToken = tokens.access_token;
    req.session.refreshToken = tokens.refresh_token;
    delete req.session.oidcFlow;
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.get("/protected", async (req, res, next) => {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  try {
    const access = await fetchAccessContext(req);
    if (!access.context) {
      res.status(403).json({ error: access.error ?? "directory access denied" });
      return;
    }
    res.json({ message: "You reached a protected Express route.", user: req.session.user, accessContext: access.context });
  } catch (error) {
    next(error);
  }
});

app.get("/logout", async (req, res, next) => {
  try {
    await clearLocalSession(req);
    res.redirect("http://localhost:3000/logout-all/app-b");
  } catch (error) {
    next(error);
  }
});

app.get("/logout/local", async (req, res, next) => {
  try {
    const returnTo = req.query.returnTo;
    if (returnTo !== "app-a" && returnTo !== "app-b") {
      res.status(400).json({ error: "invalid_logout_return" });
      return;
    }
    await clearLocalSession(req);
    const destination = new URL("http://localhost:5173/logout-complete");
    destination.searchParams.set("returnTo", returnTo);
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signing out…</title></head><body><p>Signing out of all SMZ applications…</p><script>
      try {
        const channel = new BroadcastChannel("smz-global-logout");
        channel.postMessage("logout");
        channel.close();
      } finally {
        window.location.replace(${JSON.stringify(destination.href)});
      }
    </script></body></html>`);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Unknown application error" });
});

app.listen(4000, () => console.log("Express App B listening on http://localhost:4000"));
