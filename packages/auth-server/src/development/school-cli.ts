import { config } from "../config.js";
import { db, closeDatabase } from "../db/client.js";
import { seedSchool } from "./school-seed.js";
try { await seedSchool(db, config, process.env.DEV_PARENT_EMAIL || ""); console.log("Development school ready: DEV-G1, Harry's Demo Family, two demo students, administrator and class teacher. Existing records preserved."); }
finally { await closeDatabase(); }
