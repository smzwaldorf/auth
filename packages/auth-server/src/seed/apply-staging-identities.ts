import { config } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { addStagingIdentities, approvedStagingIdentities } from "./staging-identities.js";
try {
  if (config.AUTH_ISSUER !== "https://smz-auth.black-tree-204e.workers.dev/api/auth" || config.STAGING_ADMIN_EMAIL !== approvedStagingIdentities[0].email || config.STAGING_PARENT_EMAIL !== approvedStagingIdentities[1].email) throw new Error("This migration is restricted to the confirmed staging deployment and identities");
  await addStagingIdentities(db);
  console.log("Approved staging identity migration applied or already recorded; existing records and CMS grants preserved.");
} finally { await closeDatabase(); }
