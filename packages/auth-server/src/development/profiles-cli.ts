import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { ensureProfileClient } from "../family-profiles/sign-in.js";
import { developmentLoginEnabled } from "./policy.js";

// Explicit setup only: portal visits never grant or restore capabilities.
try {
  if (!developmentLoginEnabled(config)) throw new Error("Profile setup requires an opted-in loopback development database and issuer");
  const includePersonProfiles = process.argv.includes("--include-person-profiles");
  const capabilities = JSON.stringify(includePersonProfiles ? { familyProfiles: true, personProfiles: true } : { familyProfiles: true });
  await ensureProfileClient(db, config);
  await db.transaction(async tx => {
    const result = await tx.execute(sql`
      update auth.oauth_client c
      set metadata = coalesce(c.metadata, '{}'::jsonb) || ${capabilities}::jsonb,
          updated_at = now()
      where c.client_id = 'smz-profiles' and c.disabled = false and c.public = false
        and exists (select 1 from directory.applications a where a.client_id = c.client_id and a.enabled = true)
      returning c.client_id
    `);
    if (result.rows.length !== 1) throw new Error("Native profile client is disabled or unavailable; no capabilities changed");
  });
  console.log(`Local native ${includePersonProfiles ? "family and person" : "family"} profile capabilities enabled. Membership and approval checks remain required.`);
} finally { await closeDatabase(); }
