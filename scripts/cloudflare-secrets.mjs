import fs from "node:fs/promises";
const groups = { auth: ["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APP_B_CLIENT_SECRET"], "app-b": ["APP_B_CLIENT_SECRET", "APP_B_COOKIE_SECRET"] };
for (const [name, keys] of Object.entries(groups)) {
  if (name === "app-b" && process.env.DEPLOY_DEMO_APPS !== "true") continue;
  const secrets = {};
  for (const key of keys) {
    const value = process.env[key];
    if (!value || /local-|change-me|placeholder/i.test(value)) throw new Error(`Missing production ${key}`);
    if (["BETTER_AUTH_SECRET", "APP_B_CLIENT_SECRET", "APP_B_COOKIE_SECRET"].includes(key) && value.length < 32) throw new Error(`${key} must contain at least 32 characters`);
    secrets[key] = value;
  }
  await fs.writeFile(`.wrangler/deploy/${name}-secrets.json`, JSON.stringify(secrets), { mode: 0o600 });
}
