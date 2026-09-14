import { eq } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { applications, oauthClient } from "../db/schema.js";
import { siteCatalog } from "./sites.js";
export function applicationService(db: Database, _config: RuntimeConfig) {
  async function list() {
    const registrations = await db.select({ clientId: applications.clientId, displayName: applications.displayName, publicOrigin: applications.publicOrigin, enabled: applications.enabled, oauthDisabled: oauthClient.disabled, publicClient: oauthClient.public }).from(applications).innerJoin(oauthClient, eq(oauthClient.clientId, applications.clientId)).orderBy(applications.displayName, applications.clientId);
    return { ...siteCatalog(registrations), registrations };
  }
  return { list, catalog: list };
}
