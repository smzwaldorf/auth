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
  const authOrigin = new URL(issuer).origin;
  const launcher = await fetch(authOrigin);
  const html = await launcher.text();
  if (!launcher.ok || !html.includes(`href="${process.env.APP_A_ORIGIN}"`) || !html.includes(`href="${process.env.APP_B_ORIGIN}"`)) throw new Error("Launcher is missing deployed applications");
  for (const path of ["/", "/callback"]) {
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
