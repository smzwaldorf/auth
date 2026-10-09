import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/database.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { createDirectory } from "../directory/service.js";
import { hasLiveSession } from "../global-logout.js";

export class ProfileError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
export type ProfileActor = {
  personId: string;
  clientId: string;
  sessionId: string;
};
type Connection = Pick<Database, "execute">;
export async function rows<T = Record<string, any>>(
  db: Connection,
  query: SQL,
): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}
export const activeMembership = sql`m.status='active' and (m.starts_on is null or m.starts_on <= (now() at time zone 'UTC')::date) and (m.ends_on is null or m.ends_on >= (now() at time zone 'UTC')::date)`;
export function profileAccess(
  db: Database,
  config: RuntimeConfig,
  capability: "familyProfiles" | "personProfiles",
) {
  async function run<T>(
    actor: ProfileActor,
    fn: (
      tx: Database,
      access: { reviewer: boolean; own: string[]; membershipIds: string[] },
    ) => Promise<T>,
  ) {
    return db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      // Same lock as directory administration: membership edits and decisions serialize.
      await tx.execute(sql`select pg_advisory_xact_lock(73692041)`);
      if (!(await hasLiveSession(tx, actor.personId, actor.sessionId)))
        throw new ProfileError(403, "登入或權限已失效，請重新登入。");
      const context = await createDirectory(tx, config).getAccessContext(
        actor.personId,
        actor.clientId,
      );
      const [client] = await rows(
        tx,
        sql`select 1 from auth.oauth_client where client_id=${actor.clientId} and disabled=false and public=false and metadata->>${capability}='true'`,
      );
      if (!context || !client)
        throw new ProfileError(403, "此帳號或應用程式沒有此資料的存取權限。");
      const memberships = await rows(
        tx,
        sql`select m.id, m.family_id from directory.family_memberships m join directory.families f on f.id=m.family_id where m.person_id=${actor.personId} and m.relationship in ('father','mother','guardian') and ${activeMembership} and f.status='active'`,
      );
      const reviewer =
        context.roles.includes("admin") ||
        (
          await rows(
            tx,
            sql`select 1 from directory.family_profile_reviewers where person_id=${actor.personId}`,
          )
        ).length > 0;
      return fn(tx, {
        reviewer,
        own: memberships.map((m) => m.family_id),
        membershipIds: memberships.map((m) => m.id),
      });
    });
  }
  return run;
}
