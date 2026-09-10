import fs from "node:fs/promises";
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !destination.endsWith(".private.json")) throw new Error("Usage: node scripts/prepare-seed.mjs INPUT OUTPUT.private.json");
const origins = [process.env.APP_A_ORIGIN, process.env.APP_B_ORIGIN];
if (origins.some(origin => !origin || new URL(origin).origin !== origin || new URL(origin).protocol !== "https:")) throw new Error("Set APP_A_ORIGIN and APP_B_ORIGIN to exact HTTPS origins");
const seed = JSON.parse(await fs.readFile(source, "utf8"));
for (const app of seed.applications) {
  const origin = app.clientId === "vite-app" ? origins[0] : app.clientId === "express-app" ? origins[1] : undefined;
  if (!origin) continue;
  app.publicOrigin = origin;
  app.redirectUris = [`${origin}${app.clientId === "vite-app" ? "/callback" : "/auth/callback"}`];
  app.postLogoutRedirectUris = [`${origin}/`];
}
await fs.writeFile(destination, JSON.stringify(seed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("Created private seed with production client origins; review before applying.");
