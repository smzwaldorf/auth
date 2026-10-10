import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'

const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

if (process.env.DEPLOYMENT_ENVIRONMENT !== 'production' || process.env.PRODUCTION_DATABASE_RESET_APPROVED !== 'true') {
  throw new Error('Production Auth reset requires the explicit workflow approval')
}
if (process.env.AUTH_ISSUER !== 'https://auth.smzwaldorf.com/api/auth' || process.env.CMS_ORIGIN !== 'https://news.smzwaldorf.com') {
  throw new Error('Unexpected production Auth origins')
}
const account = required('CLOUDFLARE_ACCOUNT_ID')
const hyperdrive = required('CLOUDFLARE_HYPERDRIVE_ID')
if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9]{32}$/i.test(hyperdrive)) throw new Error('Invalid Cloudflare configuration')
const cmsSecretHash = createHash('sha256').update(required('CMS_OIDC_CLIENT_SECRET')).digest('base64url')
const root = new URL('../', import.meta.url).pathname
const directoryAudience = 'https://auth.smzwaldorf.com/api/directory/v1'
const seed = {
  audience: directoryAudience,
  resourceId: `resource:${directoryAudience}`,
  scopes: ['openid', 'profile', 'email', 'directory:access', 'offline_access'],
  administrators: [
    { id: '81000000-0000-4000-8000-000000000001', invitationId: '81000000-0000-4000-8000-000000000002', name: 'SMZ Waldorf', email: 'smzwaldorf.education@gmail.com' },
    { id: '81000000-0000-4000-8000-000000000003', invitationId: '81000000-0000-4000-8000-000000000004', name: '善美真華德福', email: 'info@smzwaldorf.com' },
  ],
  clients: [
    { clientId: 'email-cms', name: 'News', secret: null, redirectUri: 'https://news.smzwaldorf.com/auth/callback', logoutUri: 'https://news.smzwaldorf.com/login', frontChannelLogoutUri: 'https://news.smzwaldorf.com/logout/local', public: true },
    { clientId: 'email-cms-server', name: 'News server', secret: cmsSecretHash, redirectUri: 'https://news.smzwaldorf.com/api/session/callback', logoutUri: 'https://news.smzwaldorf.com/login', frontChannelLogoutUri: 'https://news.smzwaldorf.com/logout/local', public: false },
  ],
}

await mkdir(`${root}.wrangler/`, { recursive: true })
const temporary = await mkdtemp(`${root}.wrangler/auth-production-reset-`)
const token = randomBytes(32).toString('hex')
const server = createServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
await new Promise(resolve => server.close(resolve))

await writeFile(`${temporary}/worker.mjs`, `
import pg from 'pg';
const seed = ${JSON.stringify(seed)};
const quote = value => '"' + value.replaceAll('"', '""') + '"';
async function resetAndSeed(client) {
  const identity = await client.query('SELECT current_database() AS name');
  if (identity.rows[0]?.name !== 'production-auth') throw new Error('Wrong logical database');
  const migrated = await client.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  if (migrated.rows[0]?.count !== 8) throw new Error('Unexpected Auth migration history');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='30s'");
    await client.query("SET LOCAL statement_timeout='90s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('auth-production-reset'))");
    const {rows: tables} = await client.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY(ARRAY['auth', 'directory']) ORDER BY schemaname, tablename");
    if (!tables.some(row => row.schemaname === 'auth' && row.tablename === 'oauth_client') || !tables.some(row => row.schemaname === 'directory' && row.tablename === 'people')) throw new Error('Unexpected Auth schema');
    await client.query('TRUNCATE TABLE ' + tables.map(row => quote(row.schemaname) + '.' + quote(row.tablename)).join(', ') + ' RESTART IDENTITY CASCADE');
    for (const administrator of seed.administrators) {
      await client.query('INSERT INTO auth.user (id, name, email, email_verified, updated_at) VALUES ($1, $2, $3, true, now())', [administrator.id, administrator.name, administrator.email]);
      await client.query("INSERT INTO directory.people (id, kind, display_name, normalized_login_email, status, updated_at) VALUES ($1, 'adult', $2, $3, 'active', now())", [administrator.id, administrator.name, administrator.email]);
      await client.query("INSERT INTO directory.login_invitations (id, person_id, normalized_email, status, activated_at, updated_at) VALUES ($1, $2, $3, 'activated', now(), now())", [administrator.invitationId, administrator.id, administrator.email]);
      await client.query("INSERT INTO directory.person_roles (person_id, role) VALUES ($1, 'admin')", [administrator.id]);
    }
    await client.query('INSERT INTO auth.oauth_resource (id, identifier, name, access_token_ttl, refresh_token_ttl, allowed_scopes, dpop_bound_access_tokens_required, disabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, false, false, now(), now())', [seed.resourceId, seed.audience, 'SMZ Directory API', 900, 2592000, seed.scopes]);
    for (const application of seed.clients) {
      await client.query('INSERT INTO auth.oauth_client (id, client_id, client_secret, disabled, skip_consent, enable_end_session, scopes, created_at, updated_at, name, redirect_uris, post_logout_redirect_uris, token_endpoint_auth_method, application_type, grant_types, response_types, public, type, require_pkce, metadata) VALUES ($1, $2, $3, false, true, true, $4, now(), now(), $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14::jsonb)', [\`client:\${application.clientId}\`, application.clientId, application.secret, seed.scopes, application.name, [application.redirectUri], [application.logoutUri], application.public ? 'none' : 'client_secret_post', 'web', ['authorization_code', 'refresh_token'], ['code'], application.public, 'web', JSON.stringify({clientId: application.clientId, frontChannelLogoutUri: application.frontChannelLogoutUri})]);
      await client.query('INSERT INTO auth.oauth_client_resource (id, client_id, resource_id, created_at) VALUES ($1, $2, $3, now())', [\`client-resource:\${application.clientId}:\${seed.audience}\`, application.clientId, seed.audience]);
      await client.query('INSERT INTO directory.applications (client_id, display_name, public_origin, enabled, updated_at) VALUES ($1, $2, $3, true, now())', [application.clientId, application.name, 'https://news.smzwaldorf.com']);
      for (const administrator of seed.administrators) await client.query("INSERT INTO directory.app_access (person_id, client_id, status, updated_at) VALUES ($1, $2, 'active', now())", [administrator.id, application.clientId]);
    }
    const people = await client.query('SELECT count(*)::int AS count FROM directory.people');
    const clients = await client.query('SELECT count(*)::int AS count FROM auth.oauth_client');
    if (people.rows[0]?.count !== 2 || clients.rows[0]?.count !== 2) throw new Error('Auth production seed verification failed');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
export default { async fetch(request, env) {
  if (request.headers.get('authorization') !== 'Bearer ' + env.CHECK_TOKEN) return new Response(null, {status:404});
  if (request.method === 'GET') return new Response(null, {status:204});
  if (request.method !== 'POST') return new Response(null, {status:405});
  const client = new pg.Client({connectionString:env.HYPERDRIVE.connectionString, connectionTimeoutMillis:15000});
  try { await client.connect(); await resetAndSeed(client); return Response.json({database:'production-auth', seeded:true}); }
  catch (error) { return Response.json({error:'Auth production reset failed', code:error.code ?? null}, {status:503}); }
  finally { await client.end().catch(() => {}); }
}};
`)
await writeFile(`${temporary}/wrangler.json`, JSON.stringify({
  name: 'production-smz-auth-reset', main: './worker.mjs', account_id: account,
  compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  hyperdrive: [{ binding: 'HYPERDRIVE', id: hyperdrive }], vars: { CHECK_TOKEN: token },
}))
const child = spawn(process.execPath, [`${root}node_modules/wrangler/bin/wrangler.js`, 'dev', '--remote', '--config', `${temporary}/wrangler.json`, '--ip', '127.0.0.1', '--port', String(port)], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: `${temporary}/logs` },
})
let output = ''
const capture = data => { output = (output + data.toString().replaceAll(token, '[redacted]')).slice(-6000) }
child.stdout.on('data', capture)
child.stderr.on('data', capture)
const endpoint = `http://127.0.0.1:${port}/`
const headers = { Authorization: `Bearer ${token}` }
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Hyperdrive preview exited: ${output}`)
    try { ready = (await fetch(endpoint, { headers, signal: AbortSignal.timeout(1000) })).status === 204 } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error(`Hyperdrive preview did not become ready: ${output}`)
  const response = await fetch(endpoint, { method: 'POST', headers, signal: AbortSignal.timeout(120000) })
  const result = await response.json()
  if (!response.ok || result.database !== 'production-auth' || result.seeded !== true) throw new Error(JSON.stringify(result))
  console.info('Cleared and seeded production-auth through Hyperdrive')
} finally {
  if (child.exitCode === null) {
    process.kill(-child.pid, 'SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))])
    if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
  }
  await rm(temporary, { recursive: true, force: true })
}
