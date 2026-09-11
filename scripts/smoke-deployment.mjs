const issuer = process.env.AUTH_ISSUER;
if (!issuer) throw new Error("Missing AUTH_ISSUER");
const checks = [[`${new URL(issuer).origin}/health`, "health"], [`${issuer}/.well-known/openid-configuration`, "discovery"]];
if (process.env.DEPLOY_DEMO_APPS === "true") checks.push([`${process.env.APP_B_ORIGIN}/health`, "app-b"]);
for (const [url, kind] of checks) {
  let data;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { const response = await fetch(url); if (!response.ok) throw new Error(String(response.status)); data = await response.json(); break; }
    catch (error) { if (attempt === 5) throw new Error(`${kind} unavailable: ${error.message}`); await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  if (kind === "discovery" ? data.issuer !== issuer || !data.code_challenge_methods_supported?.includes("S256") : data.ok !== true) throw new Error(`Invalid ${kind} response`);
}
if (process.env.DEPLOY_DEMO_APPS === "true") {
  const login = await fetch(`${process.env.APP_B_ORIGIN}/login`, { redirect: "manual" });
  if (login.status !== 302) throw new Error(`App B login unavailable: ${login.status}`);
  const authorize = new URL(login.headers.get("location"));
  if (authorize.origin !== new URL(issuer).origin || authorize.pathname !== `${new URL(issuer).pathname}/oauth2/authorize`
    || authorize.searchParams.get("client_id") !== "express-app"
    || authorize.searchParams.get("redirect_uri") !== `${process.env.APP_B_ORIGIN}/auth/callback`
    || authorize.searchParams.get("code_challenge_method") !== "S256"
    || !authorize.searchParams.get("code_challenge") || !authorize.searchParams.get("state")
    || !authorize.searchParams.get("nonce")
    || !login.headers.get("set-cookie")?.includes("__Host-smz-app-b.0=")) {
    throw new Error("App B login did not establish a PKCE authorization flow and session cookie");
  }
  const authOrigin = new URL(issuer).origin;
  const launcher = await fetch(authOrigin);
  const html = await launcher.text();
  if (!launcher.ok || (process.env.DEPLOY_PAGES !== "false" && !html.includes(`href="${process.env.APP_A_ORIGIN}"`)) || !html.includes(`href="${process.env.APP_B_ORIGIN}"`)) throw new Error("Launcher is missing deployed applications");
  for (const path of (process.env.DEPLOY_PAGES === "false" ? [] : ["/", "/callback"])) {
    let ready = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await fetch(`${process.env.APP_A_ORIGIN}${path}`);
        ready = response.ok && (await response.text()).includes('id="root"');
      } catch { /* Pages DNS and publication can take a moment to propagate. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!ready) throw new Error(`App A unavailable at ${path}`);
  }
  const signIn = await fetch(`${authOrigin}/sign-in`, { redirect: "manual" });
  if (signIn.status !== 302 || signIn.headers.get("location") !== "/") throw new Error("Direct sign-in did not return to launcher");
}
console.log("Deployment health, discovery, and enabled frontend checks passed; Google browser smoke is a separate gate.");
