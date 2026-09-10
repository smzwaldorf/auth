const issuer = process.env.AUTH_ISSUER;
if (!issuer) throw new Error("Missing AUTH_ISSUER");
const checks = [[`${new URL(issuer).origin}/health`, "health"], [`${issuer}/.well-known/openid-configuration`, "discovery"], [`${process.env.APP_B_ORIGIN}/health`, "app-b"]];
for (const [url, kind] of checks) {
  let data;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { const response = await fetch(url); if (!response.ok) throw new Error(String(response.status)); data = await response.json(); break; }
    catch (error) { if (attempt === 5) throw new Error(`${kind} unavailable: ${error.message}`); await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  if (kind === "discovery" ? data.issuer !== issuer || !data.code_challenge_methods_supported?.includes("S256") : data.ok !== true) throw new Error(`Invalid ${kind} response`);
}
console.log("Worker health and OIDC discovery passed; Google browser smoke is a separate gate.");
