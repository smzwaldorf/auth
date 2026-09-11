import type { Database } from "./db/database.js";
import { auditEvents } from "./db/schema.js";

export function createAuditRecorder(db: Database) {
  return async function recordAuditEvent(input: {
    eventType: string;
    actor: string;
    personId?: string;
    clientId?: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await db.insert(auditEvents).values({
      eventType: input.eventType,
      actor: input.actor,
      personId: input.personId,
      clientId: input.clientId,
      detail: input.detail ?? {},
    });
  }

}
