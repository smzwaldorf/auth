import type { AuthUser, AccessContext } from "./types.js";
function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] ?? character);
}

export function page(issuer: string, appAOrigin: string, user?: AuthUser, accessContext?: AccessContext, accessError?: string): string {
  const authenticated = Boolean(user);
  const signedIn = Boolean(user && accessContext?.access === "active");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App B · SMZ Auth</title>
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
      <header><div class="mark">B</div><div><span class="eyebrow">Confidential OIDC client</span><h1>App B</h1></div></header>
      <section class="status"><div class="dot"></div><div><span class="eyebrow">Authentication status</span><strong>${signedIn ? "Authenticated" : "Not authenticated"}</strong></div></section>
      ${user ? `
        <section class="panel"><h2>${escapeHtml(user.name ?? "Signed-in user")}</h2><p>${escapeHtml(user.email ?? "No email claim")}</p></section>
        <dl>
          <div><dt>Issuer</dt><dd>${escapeHtml(user.iss ?? issuer)}</dd></div>
          <div><dt>Subject</dt><dd>${escapeHtml(user.sub)}</dd></div>
          <div><dt>Client ID</dt><dd>express-app</dd></div>
          <div><dt>Session</dt><dd>Encrypted HttpOnly cookie</dd></div>
          <div><dt>Directory access</dt><dd>${escapeHtml(accessContext?.access ?? accessError ?? "unavailable")}</dd></div>
          <div><dt>School roles</dt><dd>${escapeHtml(accessContext?.roles.join(", ") || "none")}</dd></div>
          <div><dt>Class scopes</dt><dd>${escapeHtml(accessContext?.classScopes.effective.join(", ") || "none")}</dd></div>
        </dl>` : `
        <section class="panel"><h2>Server-side authentication</h2><p>The authorization code is redeemed on this application server. Browser requests then use an application session cookie.</p></section>`}
      <div class="actions">
        <a href="${authenticated ? "/logout" : "/login"}">${authenticated ? "Sign out" : "Sign in through SMZ Auth"}</a>
        <a class="secondary" href="${escapeHtml(appAOrigin)}">Open Vite App A ↗</a>
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

