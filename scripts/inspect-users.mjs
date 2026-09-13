import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '15s'");
  const result = await client.query(`
    SELECT u.id, u.name, u.email, u.email_verified,
      p.kind, p.status, p.normalized_login_email,
      COALESCE((SELECT jsonb_agg(r.role ORDER BY r.role) FROM directory.person_roles r WHERE r.person_id=p.id), '[]') AS roles,
      (SELECT jsonb_build_object('status', i.status, 'email', i.normalized_email, 'expiresAt', i.expires_at)
       FROM directory.login_invitations i WHERE i.person_id=p.id) AS invitation,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('clientId', a.client_id, 'status', a.status, 'appEnabled', ap.enabled) ORDER BY a.client_id)
        FROM directory.app_access a JOIN directory.applications ap USING (client_id) WHERE a.person_id=p.id), '[]') AS access,
      COALESCE((SELECT jsonb_agg(DISTINCT a.provider_id) FROM auth.account a WHERE a.user_id=u.id), '[]') AS providers
    FROM auth."user" u LEFT JOIN directory.people p ON p.id::text=u.id
    ORDER BY lower(u.email)`);
  const directory = await client.query('SELECT kind, status, count(*)::int AS count FROM directory.people GROUP BY kind, status ORDER BY kind, status');
  console.log(JSON.stringify({ inspectedAt: new Date().toISOString(), userCount: result.rowCount, directoryCounts: directory.rows }));
  for (const row of result.rows) console.log(JSON.stringify({ user: row }));
  await client.query('ROLLBACK');
} catch (error) {
  console.error('Read-only user inspection failed', error.code ?? 'UNKNOWN');
  process.exitCode = 1;
} finally { await client.end(); }
