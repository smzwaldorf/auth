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
  const administrators = [
    {id:'81000000-0000-4000-8000-000000000001',kind:'adult' as const,displayName:'SMZ Waldorf',loginEmail:'smzwaldorf.education@gmail.com',status:'active' as const,roles:['admin'] as const,invitation:{id:'81000000-0000-4000-8000-000000000002',status:'activated' as const}},
    {id:'81000000-0000-4000-8000-000000000003',kind:'adult' as const,displayName:'善美真華德福',loginEmail:'info@smzwaldorf.com',status:'active' as const,roles:['admin'] as const,invitation:{id:'81000000-0000-4000-8000-000000000004',status:'activated' as const}},
  ];
  const origin = config.CMS_ORIGIN;
  const applications = [
    {clientId:'email-cms',displayName:'News',clientType:'public',publicOrigin:origin,redirectUris:[`${origin}/auth/callback`],postLogoutRedirectUris:[`${origin}/login`],frontChannelLogoutUri:`${origin}/logout/local`,scopes:['openid','profile','email','directory:access','offline_access']},
    {clientId:'email-cms-server',displayName:'News server',clientType:'confidential',clientSecretEnv:'CMS_OIDC_CLIENT_SECRET',publicOrigin:origin,redirectUris:[`${origin}/api/session/callback`],postLogoutRedirectUris:[`${origin}/login`],frontChannelLogoutUri:`${origin}/logout/local`,scopes:['openid','profile','email','directory:access','offline_access']},
  ];
  await applyDirectorySeed(validateDirectorySeed({version:1,school:{code:'smzwaldorf',displayName:'SMZ Waldorf'},people:administrators,families:[],classes:[],applications,appAccess:applications.flatMap(app=>administrators.map(({id:personId})=>({personId,clientId:app.clientId,status:'active' as const})))}));
  console.info('Created the explicitly approved SMZ production administrators; no demo identities imported.');
} finally { await closeDatabase(); }
