import fs from "node:fs/promises";
import path from "node:path";
const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const deployApps = process.env.DEPLOY_DEMO_APPS === "true";
const vars = Object.fromEntries(["AUTH_ISSUER", "APP_A_ORIGIN", "APP_B_ORIGIN"].map(name => [name, required(name)]));
for (const [name, value] of Object.entries(vars)) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /localhost|127\.0\.0\.1|\.example\.com$/.test(url.hostname)) throw new Error(`Invalid production ${name}`);
  if (name === "AUTH_ISSUER" ? url.pathname !== "/api/auth" : url.origin !== value) throw new Error(`Invalid path in ${name}`);
}
if (new Set(Object.values(vars).map(value => new URL(value).origin)).size !== 3) throw new Error("Auth, App A and App B require distinct origins");
if (deployApps && !/^[a-z0-9][a-z0-9-]*$/.test(required("PAGES_PROJECT_NAME"))) throw new Error("Invalid Pages project name");
const id = required("CLOUDFLARE_HYPERDRIVE_ID");
if (!/^[a-f0-9]{32}$/i.test(id) || /^0+$/.test(id)) throw new Error("Invalid Hyperdrive ID");
const account = required("CLOUDFLARE_ACCOUNT_ID");
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid account ID");
await fs.mkdir(".wrangler/deploy", { recursive: true });
for (const [name, source, hostname] of [["auth", "packages/auth-server", new URL(vars.AUTH_ISSUER).hostname], ["app-b", "apps/express-app", new URL(vars.APP_B_ORIGIN).hostname]]) {
  if (name === "app-b" && !deployApps) continue;
  const config = JSON.parse(await fs.readFile(`${source}/wrangler.jsonc`, "utf8"));
  delete config.$schema;
  config.main = path.resolve(source, config.main);
  config.account_id = account;
  config.vars = vars;
  if (name === "auth") config.hyperdrive = [{ binding: "HYPERDRIVE", id }];
  else { delete config.hyperdrive; delete config.triggers; }
  if (hostname.endsWith(".workers.dev")) {
    if (!new RegExp(`^${config.name}\\.[a-z0-9-]+\\.workers\\.dev$`).test(hostname)) throw new Error(`The ${name} workers.dev hostname must match Worker name ${config.name}`);
    config.workers_dev = true;
    delete config.routes;
  } else {
    config.workers_dev = false;
    config.routes = [{ pattern: hostname, custom_domain: true }];
  }
  await fs.writeFile(`.wrangler/deploy/${name}.json`, JSON.stringify(config, null, 2));
}
console.log("Generated production Worker configurations.");
