import { and, eq } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { people, personRoles } from "../db/schema.js";
import { loginAllowed } from "../login-policy.js";
import { isDevelopmentIdentity } from "../development/policy.js";
import { validDevelopmentIdentity } from "../development/identity.js";

type Connection = Pick<Database, "select">;
export async function isAdmin(db: Connection, config: RuntimeConfig, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [person] = await db.select({ id: people.id }).from(people)
    .innerJoin(personRoles, and(eq(personRoles.personId, people.id), eq(personRoles.role, "admin")))
    .where(and(eq(people.id, id), eq(people.kind, "adult"), eq(people.status, "active"))).limit(1);
  // Both policy helpers only select; keep the transaction's reads on its connection.
  return Boolean(person) && (isDevelopmentIdentity(id)
    ? validDevelopmentIdentity(db as Database, config, id)
    : loginAllowed(db as Database, config, id));
}
