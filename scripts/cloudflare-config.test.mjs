import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('generated Auth deployment preserves the additional parent allowlist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'smz-config-test-'));
 try {
  await mkdir(join(root,'packages/auth-server'),{recursive:true});
  await writeFile(join(root,'packages/auth-server/wrangler.jsonc'),await readFile(new URL('../packages/auth-server/wrangler.jsonc',import.meta.url)));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cloudflare-config.mjs',import.meta.url))],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,AUTH_ISSUER:'https://auth.school.test/api/auth',APP_A_ORIGIN:'https://a.school.test',APP_B_ORIGIN:'https://b.school.test',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_HYPERDRIVE_ID:'b'.repeat(32),STAGING_PARENT_EMAILS:'parent-a@school.test,parent-b@school.test'}});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(await readFile(join(root,'.wrangler/deploy/auth.json'),'utf8'));
  assert.equal(config.vars.STAGING_PARENT_EMAILS,'parent-a@school.test,parent-b@school.test');
 }finally{await rm(root,{recursive:true,force:true})}
});
