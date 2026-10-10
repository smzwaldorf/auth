import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'

if (process.env.DEPLOYMENT_ENVIRONMENT !== 'production') throw new Error('Production environment required')
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const hyperdrive = process.env.CLOUDFLARE_HYPERDRIVE_ID
if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !/^[a-f0-9]{32}$/i.test(hyperdrive ?? '')) throw new Error('Invalid Cloudflare configuration')
const root = new URL('../', import.meta.url).pathname
await mkdir(`${root}.wrangler/`, { recursive: true })
const temporary = await mkdtemp(`${root}.wrangler/auth-query-diagnostic-`)
const token = randomBytes(32).toString('hex')
const server = createServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const port = server.address().port
await new Promise(resolve => server.close(resolve))
await writeFile(`${temporary}/worker.mjs`, `
import pg from 'pg';
export default { async fetch(request, env) {
  if (request.headers.get('authorization') !== 'Bearer ' + env.CHECK_TOKEN) return new Response(null, {status:404});
  if (request.method === 'GET') return new Response(null, {status:204});
  const client = new pg.Client({connectionString:env.HYPERDRIVE.connectionString, connectionTimeoutMillis:15000});
  try {
    await client.connect();
    const database = await client.query('SELECT current_database() AS name');
    const result = await client.query('select directory.applications.client_id, directory.applications.display_name, directory.applications.public_origin, auth.oauth_client.redirect_uris, auth.oauth_client.public from directory.applications inner join auth.oauth_client on directory.applications.client_id = auth.oauth_client.client_id where directory.applications.enabled = true and auth.oauth_client.disabled = false order by directory.applications.display_name');
    return Response.json({database:database.rows[0]?.name, applicationCount:result.rows.length});
  } catch (error) {
    console.error(String(error?.stack ?? error).replace(/pscale_pw_[A-Za-z0-9_-]+/g, '[REDACTED]'));
    return Response.json({error:'Hyperdrive landing query failed', code:error.code ?? null, message:String(error.message).replace(/pscale_pw_[A-Za-z0-9_-]+/g, '[REDACTED]')}, {status:503});
  } finally { await client.end().catch(() => {}); }
}};
`)
await writeFile(`${temporary}/wrangler.json`, JSON.stringify({name:'production-smz-auth-query-diagnostic',main:'./worker.mjs',account_id:account,compatibility_date:'2026-09-01',compatibility_flags:['nodejs_compat'],hyperdrive:[{binding:'HYPERDRIVE',id:hyperdrive}],vars:{CHECK_TOKEN:token}}))
const child = spawn(process.execPath, [`${root}node_modules/wrangler/bin/wrangler.js`, 'dev', '--remote', '--config', `${temporary}/wrangler.json`, '--ip', '127.0.0.1', '--port', String(port)], {cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:`${temporary}/logs`}})
let output = ''
const capture = data => { output = (output + data.toString().replaceAll(token, '[redacted]')).slice(-6000) }
child.stdout.on('data', capture)
child.stderr.on('data', capture)
const endpoint = `http://127.0.0.1:${port}/`
const headers = {Authorization:`Bearer ${token}`}
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Hyperdrive preview exited: ${output}`)
    try { ready = (await fetch(endpoint,{headers,signal:AbortSignal.timeout(1000)})).status === 204 } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve,1000))
  }
  if (!ready) throw new Error(`Hyperdrive preview did not become ready: ${output}`)
  const response = await fetch(endpoint,{method:'POST',headers,signal:AbortSignal.timeout(30000)})
  const body = await response.text()
  let result
  try { result = JSON.parse(body) } catch { throw new Error(`Unexpected Hyperdrive diagnostic response (${response.status}): ${body.slice(0, 500)}; ${output}`) }
  console.info(JSON.stringify(result))
  if (!response.ok) process.exitCode = 1
} finally {
  if (child.exitCode === null) { process.kill(-child.pid,'SIGTERM'); await Promise.race([once(child,'exit'),new Promise(resolve => setTimeout(resolve,5000))]); if (child.exitCode === null) process.kill(-child.pid,'SIGKILL') }
  await rm(temporary,{recursive:true,force:true})
}
