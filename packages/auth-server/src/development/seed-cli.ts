import { config, trustedClientIds } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { createDevelopmentSeeder } from "./seed.js";
try {
  await createDevelopmentSeeder(db, config, { trustedClientIds })();
  console.log("Local development identities verified/provisioned, including admin@smzwaldorf.com and teacher@smzwaldorf.com.");
} finally { await closeDatabase(); }
