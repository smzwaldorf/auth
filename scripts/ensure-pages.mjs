const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, PAGES_PROJECT_NAME: name } = process.env;
if (!account || !token || !name) throw new Error("Missing Pages deployment configuration");
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const lookup = await fetch(`${base}/${encodeURIComponent(name)}`, { headers });
if (lookup.ok) { console.log("Pages project exists"); }
else if (lookup.status === 404) {
  const created = await fetch(base, { method: "POST", headers, body: JSON.stringify({ name, production_branch: "main" }) });
  if (!created.ok) throw new Error(`Pages project creation failed: ${created.status}`);
  console.log("Pages project created");
} else throw new Error(`Pages lookup failed: ${lookup.status}`);
