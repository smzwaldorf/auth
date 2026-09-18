import {readFileSync} from 'node:fs';
import {demoId as id,row,runSeed,isMain} from './demo-seed-support.mjs';
const defaults=JSON.parse(readFileSync(new URL('./demo-families.json',import.meta.url),'utf8'));
export function buildAdminPlan(env={}) {
 const email=(env.DEMO_ADMIN_EMAIL??'').trim().toLowerCase();
 const parents=[env.DEMO_PARENT_A_EMAIL??defaults.parentAEmail,env.DEMO_PARENT_B_EMAIL??defaults.parentBEmail,env.STAGING_PARENT_EMAIL??'',...(env.STAGING_PARENT_EMAILS??'').split(',')].map(e=>e.trim().toLowerCase());
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||parents.includes(email))throw Error('Set a distinct DEMO_ADMIN_EMAIL; a demo parent cannot be the admin');
 if(env.STAGING_ADMIN_EMAIL && env.STAGING_ADMIN_EMAIL.trim().toLowerCase()!==email)throw Error('DEMO_ADMIN_EMAIL must match the configured staging administrator');
 if(env.NODE_ENV==='production'&&(env.ENABLE_DEV_LOGIN==='true'||/\.(invalid|test)$/.test(email)))throw Error('Hosted admin requires a real controlled inbox and development login disabled');
 return [
 row('directory.people','id',{id:id(951),kind:'adult',display_name:'Demo Administrator',normalized_login_email:email}),
 row('auth.user','id',{id:id(951),name:'Demo Administrator',email,email_verified:false}),
 row('directory.person_roles',['person_id','role'],{person_id:id(951),role:'admin'}),
 row('directory.login_invitations','id',{id:id(952),person_id:id(951),normalized_email:email,status:'pending'}),
 row('directory.audit_events','id',{id:id(953),event_type:'demo.admin.seed.created',actor:'operator:seed-demo-admin',detail:JSON.stringify({profile:'smz-newsletter-demo-v1',requiresEmailVerification:true})})
 ];
}
if(isMain(import.meta.url))runSeed(buildAdminPlan,['.env']).catch(error=>{console.error(error.message);process.exitCode=1});
