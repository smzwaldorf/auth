import { closeDatabase } from "../db/client.js";
import { config } from "../config.js";
import { applyDirectorySeed } from "./apply.js";
import { validateDirectorySeed } from "./model.js";

// Register clients only: never import example people or alter directory access.
const applications = [
  { clientId: "vite-app", displayName: "App A", clientType: "public", publicOrigin: config.APP_A_ORIGIN, redirectUris: [`${config.APP_A_ORIGIN}/callback`], postLogoutRedirectUris: [`${config.APP_A_ORIGIN}/`], scopes: ["openid", "profile", "email", "directory:access", "offline_access"] },
  { clientId: "express-app", displayName: "App B", clientType: "confidential", clientSecretEnv: "APP_B_CLIENT_SECRET", publicOrigin: config.APP_B_ORIGIN, redirectUris: [`${config.APP_B_ORIGIN}/auth/callback`], postLogoutRedirectUris: [`${config.APP_B_ORIGIN}/`], scopes: ["openid", "profile", "email", "directory:access", "offline_access"] },
];
try {
  await applyDirectorySeed(validateDirectorySeed({ version: 1, school: { code: "smzwaldorf", displayName: "SMZ Waldorf" }, people: [], families: [], classes: [], applications: applications.filter(app => process.env.DEPLOY_PAGES !== "false" || app.clientId !== "vite-app"), appAccess: [] }));
  console.log("Registered enabled OAuth test apps with exact deployment origins.");
} finally { await closeDatabase(); }
