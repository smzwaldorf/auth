import { closeDatabase } from "../db/client.js";
import { config } from "../config.js";
import { applyDirectorySeed } from "./apply.js";
import { validateDirectorySeed } from "./model.js";

// Register clients only: never import example people or alter directory access.
const applications = [
  { clientId: "vite-app", displayName: "App A", clientType: "public", publicOrigin: config.APP_A_ORIGIN, redirectUris: [`${config.APP_A_ORIGIN}/callback`], postLogoutRedirectUris: [`${config.APP_A_ORIGIN}/`], frontChannelLogoutUri: `${config.APP_A_ORIGIN}/logout/local`, scopes: ["openid", "profile", "email", "directory:access", "offline_access"] },
  { clientId: "express-app", displayName: "App B", clientType: "confidential", clientSecretEnv: "APP_B_CLIENT_SECRET", publicOrigin: config.APP_B_ORIGIN, redirectUris: [`${config.APP_B_ORIGIN}/auth/callback`], postLogoutRedirectUris: [`${config.APP_B_ORIGIN}/`], frontChannelLogoutUri: `${config.APP_B_ORIGIN}/logout/local`, scopes: ["openid", "profile", "email", "directory:access", "offline_access"] },
];
if (config.CMS_ORIGIN) applications.push({ clientId: "email-cms", displayName: "Email CMS", clientType: "public", publicOrigin: config.CMS_ORIGIN, redirectUris: [`${config.CMS_ORIGIN}/auth/callback`], postLogoutRedirectUris: [`${config.CMS_ORIGIN}/login`], frontChannelLogoutUri: `${config.CMS_ORIGIN}/logout/local`, scopes: ["openid", "profile", "email", "directory:access", "offline_access"] });
try {
  await applyDirectorySeed(validateDirectorySeed({ version: 1, school: { code: "smzwaldorf", displayName: "SMZ Waldorf" }, people: [], families: [], classes: [], applications: applications.filter(app => app.clientId === "email-cms" || (process.env.DEPLOY_DEMO_APPS === "true" && (process.env.DEPLOY_PAGES !== "false" || app.clientId !== "vite-app"))), appAccess: [] }));
  console.log("Registered enabled OAuth test apps with exact deployment origins.");
} finally { await closeDatabase(); }
