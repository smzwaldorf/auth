import { config } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { grantStagingCmsAccess } from "./staging-cms-access.js";
import { approvedStagingIdentities } from "./staging-identities.js";
import { createDirectory } from "../directory/service.js";
import { eq } from "drizzle-orm";
import { people } from "../db/schema.js";
try {
  if (config.AUTH_ISSUER !== "https://staging-auth.smzwaldorf.com/api/auth" || !(["https://staging-news.smzwaldorf.com"] as readonly (string | undefined)[]).includes(config.CMS_ORIGIN) || config.STAGING_ADMIN_EMAIL !== approvedStagingIdentities[0].email || config.STAGING_PARENT_EMAIL !== approvedStagingIdentities[1].email) throw new Error("Unexpected staging configuration");
  await grantStagingCmsAccess(db);
  for (const { email } of approvedStagingIdentities) {
    const [person] = await db.select().from(people).where(eq(people.normalizedLoginEmail, email));
    for (const clientId of ["email-cms", "email-cms-server"]) {
      const allowed = !!person && await createDirectory(db, config).hasLiveAppAccess(person.id, clientId);
      console.log(JSON.stringify({ email, clientId, allowed }));
      if (!allowed) throw new Error("CMS admission verification failed");
    }
  }
} finally { await closeDatabase(); }
