import { db } from "./db/client.js";
import { createAuditRecorder } from "./audit-service.js";
export const recordAuditEvent = createAuditRecorder(db);
