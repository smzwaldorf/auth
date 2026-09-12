import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { createApp } from '../packages/auth-server/src/app.js';
import { createAuth } from '../packages/auth-server/src/auth-factory.js';
import { config } from '../packages/auth-server/src/config.js';
import { db, closeDatabase } from '../packages/auth-server/src/db/client.js';
import { user, session } from '../packages/auth-server/src/db/schema.js';
import { applyDirectorySeed } from '../packages/auth-server/src/seed/apply.js';
import { validateDirectorySeed } from '../packages/auth-server/src/seed/model.js';
const cmsCheckout = process.env.CMS_CHECKOUT;
assert.ok(cmsCheckout, 'CMS_CHECKOUT must point at the built CMS checkout');
const require = createRequire(cmsCheckout + '/package.json');
const { createCmsApplication } = require(cmsCheckout + '/apps/backend/dist/application.js');
const { withDatabasePool } = require(cmsCheckout + '/apps/backend/dist/lib/db.js');
const { withRuntimeEnvironment } = require(cmsCheckout + '/apps/backend/dist/runtime/environment.js');
const { getSupabaseClient } = require(cmsCheckout + '/apps/backend/dist/lib/supabase.js');
assert.equal(new URL(config.DATABASE_URL).hostname,'127.0.0.1');
assert.equal(new URL(config.DATABASE_URL).port,'55444');
const browserTest=process.env.CMS_BROWSER_TEST==='true';
const cmsOrigin=browserTest?'http://localhost:55447':'http://localhost:55446';
const secret='synthetic-cms-server-secret-at-least-32-characters';
process.env.CMS_OIDC_CLIENT_SECRET=secret;
const seed=validateDirectorySeed(JSON.parse(await readFile(new URL('../packages/auth-server/seeds/directory.seed.example.json',import.meta.url),'utf8')));
seed.people[0]!.invitation!.status='activated';
if(browserTest)seed.people[0]!.roles.push('admin');
seed.applications.push({clientId:'email-cms',displayName:'CMS',clientType:'public',publicOrigin:cmsOrigin,redirectUris:[`${cmsOrigin}/auth/callback`],postLogoutRedirectUris:[`${cmsOrigin}/login`],frontChannelLogoutUri:`${cmsOrigin}/logout/local`,scopes:['openid','profile','email','directory:access','offline_access']});
seed.applications.push({...seed.applications.at(-1)!,clientId:'email-cms-server',clientType:'confidential',clientSecretEnv:'CMS_OIDC_CLIENT_SECRET',redirectUris:[`${cmsOrigin}/api/session/callback`]});
seed.appAccess.push({personId:seed.people[0]!.id,clientId:'email-cms',status:'active'});
await applyDirectorySeed(validateDirectorySeed(seed));
await db.update(user).set({emailVerified:true}).where(eq(user.id,seed.people[0]!.id));
const authConfig={...config,CMS_ORIGIN:cmsOrigin};
const app=createApp(authConfig,db);const auth=createAuth(authConfig,db);
const central=await (await auth.$context).internalAdapter.createSession(seed.people[0]!.id);
assert.ok(central);
const signature=createHmac('sha256',config.BETTER_AUTH_SECRET).update(central.token).digest('base64');
const identityCookie=`better-auth.session_token=${encodeURIComponent(`${central.token}.${signature}`)}`;
const identityServer=serve({fetch:request=>{
 if(browserTest && new URL(request.url).pathname==='/__fixture__/login')return new Response(null,{status:303,headers:{'set-cookie':identityCookie+'; Path=/; HttpOnly; SameSite=Lax',location:cmsOrigin+'/login'}});
 return app.fetch(request)
},port:55445,hostname:'127.0.0.1'});
const pool=new pg.Pool({connectionString:'postgres://session_test@127.0.0.1:55444/cms_sessions_test',max:5});
let unavailable=false; let loseRefreshResponse=false;
const environment={CMS_SESSION_ENABLED:'true',CMS_SESSION_SECRET:'a'.repeat(64),CMS_OIDC_CLIENT_SECRET:secret,APP_URL:cmsOrigin,BACKEND_CORS_ORIGIN:cmsOrigin,SMZ_AUTH_ISSUER:config.AUTH_ISSUER,NODE_ENV:'test'};
const cms=createServer((req,res)=>{
 if(browserTest && req.url==='/__fixture__/outage'){unavailable=true;res.end('outage');return}
 if(browserTest && req.url==='/__fixture__/recover'){unavailable=false;res.end('recovered');return}
 void withRuntimeEnvironment(environment,()=>withDatabasePool(pool,()=>createCmsApplication({supabase:getSupabaseClient(),corsOrigin:cmsOrigin}).handle(req,res)),{fetch:async (url:string,init:RequestInit)=>{if(unavailable)throw new Error('synthetic Identity outage');const result=await fetch(url,init);if(loseRefreshResponse && url.endsWith('/oauth2/token') && String(init.body).includes('refresh_token')){loseRefreshResponse=false;throw new Error('synthetic lost refresh response')}return result}}) });
await new Promise<void>(resolve=>cms.listen(55446,'127.0.0.1',resolve));
const request=(path:string,cookie='',init:RequestInit={})=>fetch(cmsOrigin+path,{...init,redirect:'manual',headers:{cookie,origin:cmsOrigin,'x-cms-request':'1',...init.headers}});
try {
 if(browserTest){console.log('Local synthetic browser fixture ready');await new Promise(()=>{})}
 const login=await request('/api/session/login?next=%2Fadmin','',{method:'POST'});assert.equal(login.status,200,await login.clone().text());
 const flowCookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const {url}=await login.json() as {url:string};
 const authorized=await new Promise<Response>((resolve,reject)=>{const req=httpRequest(url,{headers:{cookie:identityCookie}},res=>{const parts:Buffer[]=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:res.headers as Record<string,string>})))});req.on('error',reject);req.end()});assert.equal(authorized.status,302);
 const target=new URL(authorized.headers.get('location')!);assert.equal(target.pathname,'/api/session/callback', 'Authorization failed: ' + (target.searchParams.get('error') ?? '') + ' ' + (target.searchParams.get('error_description') ?? ''));
 const callback=await request(target.pathname+target.search,flowCookie);assert.equal(callback.status,303,await callback.clone().text());
 const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('cms-session='))!.split(';')[0]!;
 assert.match(callback.headers.getSetCookie().join(';'),/HttpOnly/);assert.match(callback.headers.getSetCookie().join(';'),/SameSite=Lax/);
 const current=await request('/api/session/current',cookie);const snapshot=await current.json() as any;assert.equal(snapshot.authorizationStatus,'active',JSON.stringify(snapshot));assert.equal(snapshot.user.email,seed.people[0]!.loginEmail);
 assert.equal((await request('/api/auth/session',cookie)).status,200);
 const sessionHash=(await import('node:crypto')).createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
 await pool.query('UPDATE cms_browser_sessions SET access_expires_at=now()-interval \'1 minute\' WHERE id_hash=$1',[sessionHash]);
 loseRefreshResponse=true;
 const concurrent=await Promise.all(Array.from({length:6},()=>request('/api/session/current',cookie).then(r=>r.json()))) as any[];
 assert.ok(concurrent.every(s=>s.authorizationStatus==='active'),JSON.stringify(concurrent));
 const renewed=(await pool.query('SELECT generation,credentials FROM cms_browser_sessions WHERE id_hash=$1',[sessionHash])).rows[0];assert.equal(renewed.generation,1);assert.ok(!renewed.credentials.includes('access_token'));
 unavailable=true;
 const outage=await (await request('/api/session/current',cookie)).json() as any;assert.equal(outage.authorizationStatus,'reconnecting');assert.equal(outage.user.id,snapshot.user.id);
 assert.equal((await request('/api/auth/session',cookie)).status,503);
 unavailable=false;
 assert.equal((await (await request('/api/session/current',cookie)).json() as any).authorizationStatus,'active');
 const csrf=await request('/api/session/logout',cookie,{method:'POST',headers:{origin:'https://attacker.test'}});assert.equal(csrf.status,403);
 await db.update(session).set({expiresAt:new Date(Date.now()-1000)}).where(eq(session.id,central.id));
 const expired=await (await request('/api/session/current',cookie)).json() as any;assert.equal(expired.authorizationStatus,'reauthentication_required');assert.equal(expired.user.id,snapshot.user.id);
 const logout=await request('/api/session/logout',cookie,{method:'POST'});assert.equal(logout.status,200);
 assert.equal((await (await request('/api/session/current',cookie)).json() as any).authorizationStatus,'revoked');
 assert.equal((await request('/api/auth/session',cookie)).status,403);
 console.log('PASS: real OIDC code/PKCE/nonce, opaque HttpOnly cookie, confidential CMS grant, six-way refresh single rotation with lost-response recovery, reload snapshot, outage/recovery, CSRF, central expiry identity preservation, explicit logout');
} finally {
 await new Promise<void>(resolve=>cms.close(()=>resolve()));await new Promise<void>(resolve=>identityServer.close(()=>resolve()));await pool.end();await closeDatabase();
}
