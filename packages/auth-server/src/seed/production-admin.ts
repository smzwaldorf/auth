import {sql} from 'drizzle-orm';
import {config} from '../config.js';
import {db,closeDatabase} from '../db/client.js';
import {applyDirectorySeed} from './apply.js';
import {validateDirectorySeed} from './model.js';

try {
  if (process.env.PRODUCTION_ADMIN_BOOTSTRAP_APPROVED !== 'true' || config.AUTH_ISSUER !== 'https://auth.smzwaldorf.com/api/auth' || config.CMS_ORIGIN !== 'https://news.smzwaldorf.com') throw new Error('Production administrator bootstrap is not approved for this environment');
  const result = await db.execute(sql`SELECT current_database() AS name`);
  if (result.rows[0]?.name !== 'production-auth') throw new Error('Wrong production database');
  const count = await db.execute(sql`SELECT count(*)::int AS total FROM directory.people`);
  if (Number(count.rows[0]?.total) !== 0) throw new Error('Bootstrap only accepts an empty directory; use normal administration afterward');
  const personId = '81000000-0000-4000-8000-000000000001';
  const origin = config.CMS_ORIGIN;
  const applications = [
    {clientId:'email-cms',displayName:'News',clientType:'public',publicOrigin:origin,redirectUris:[`${origin}/auth/callback`],postLogoutRedirectUris:[`${origin}/login`],frontChannelLogoutUri:`${origin}/logout/local`,scopes:['openid','profile','email','directory:access','offline_access']},
    {clientId:'email-cms-server',displayName:'News server',clientType:'confidential',clientSecretEnv:'CMS_OIDC_CLIENT_SECRET',publicOrigin:origin,redirectUris:[`${origin}/api/session/callback`],postLogoutRedirectUris:[`${origin}/login`],frontChannelLogoutUri:`${origin}/logout/local`,scopes:['openid','profile','email','directory:access','offline_access']},
  ];
  await applyDirectorySeed(validateDirectorySeed({version:1,school:{code:'smzwaldorf',displayName:'SMZ Waldorf'},people:[{id:personId,kind:'adult',displayName:'SMZ Waldorf',loginEmail:'smzwaldorf.education@gmail.com',status:'active',roles:['admin'],invitation:{id:'81000000-0000-4000-8000-000000000002',status:'activated'}}],families:[],classes:[],applications,appAccess:applications.map(app=>({personId,clientId:app.clientId,status:'active'}))}));
  console.info('Created the explicitly approved SMZ production administrator; no demo identities imported.');
} finally { await closeDatabase(); }
