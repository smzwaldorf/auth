import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, row } from './demo-seed-support.mjs';
import { buildDemoPlan } from './seed-demo.mjs';
const env={DEMO_PARENT_A_EMAIL:'demo.a@example.invalid',DEMO_PARENT_B_EMAIL:'demo.b@example.invalid'};
test('fixture contains no delivery events, jobs, sessions or verified/demo admin accounts',()=>{
 const rows=buildDemoPlan(env);
 assert(rows.length>0);
 assert(rows.every(r=>!/(delivery|analytics|session|oauth)/.test(r.table)));
 assert(rows.filter(r=>r.table==='auth.user').every(r=>r.values.email_verified===false));
 assert(rows.filter(r=>r.table==='directory.person_roles').every(r=>r.values.role!=='admin'));
 assert(rows.filter(r=>r.table==='public.newsletter_family_preferences').every(r=>r.values.newsletter_subscription_status==='pending'));
});
test('partial fixture aborts and does not recreate missing rows',async()=>{
 const rows=[row('public.fixture','id',{id:'one'}),row('public.fixture','id',{id:'two'})];let n=0;const log=[];
 const client={query:async(sql)=>{log.push(sql);return {rows:sql.startsWith('SELECT *')&&n++===0?[{id:'one'}]:[]}}};
 await assert.rejects(applyPlan(client,rows,{apply:true}),/Partial/);
 assert(!log.some(sql=>sql.startsWith('INSERT')));assert.equal(log.at(-1),'ROLLBACK');
});
test('rerun never resets edited fields or unsubscribed state',async()=>{
 const rows=[row('public.fixture','id',{id:'one',newsletter_subscription_status:'subscribed'})];const log=[];
 const client={query:async(sql)=>{log.push(sql);return {rows:sql.startsWith('SELECT *')?[{id:'one',newsletter_subscription_status:'unsubscribed'}]:[]}}};
 assert.deepEqual(await applyPlan(client,rows,{apply:true}),{state:'already-present',inserted:0});
 assert(!log.some(sql=>/^(INSERT|UPDATE)/.test(sql)));
});
test('email identity conflicts fail closed',async()=>{
 const client={query:async(sql)=>({rows:sql.startsWith('SELECT *')?[{id:'one',email:'existing@example.invalid'}]:[]})};
 await assert.rejects(applyPlan(client,[row('auth.user','id',{id:'one',email:'different@example.invalid'})],{apply:true}),/conflict/);
});
test('check mode uses rollback, apply uses commit, errors roll back',async()=>{
 for(const apply of [false,true]){
  const log=[];const client={query:async(sql)=>{log.push(sql);return {rows:[]}}};
  await applyPlan(client,[row('public.fixture','id',{id:'one'})],{apply});assert.equal(log.at(-1),apply?'COMMIT':'ROLLBACK');
 }
 const log=[];const client={query:async(sql)=>{log.push(sql);if(sql.startsWith('INSERT'))throw Error('collision');return {rows:[]}}};
 await assert.rejects(applyPlan(client,[row('public.fixture','id',{id:'one'})],{apply:true}),/collision/);assert.equal(log.at(-1),'ROLLBACK');
});

test('clean-start parents belong to the requested families with separate class access', () => {
 const rows=buildDemoPlan();
 const people=rows.filter(r=>r.table==='directory.people');
 const familyFor=email=>{
  const person=people.find(r=>r.values.normalized_login_email===email);
  assert(person);
  return rows.find(r=>r.table==='directory.family_memberships'&&r.values.person_id===person.values.id).values.family_id;
 };
 const a=familyFor('harryworld@gmail.com'), b=familyFor('smzwaldorf.education@gmail.com');
 assert.notEqual(a,b);
 const classesFor=family=>{
  const children=rows.filter(r=>r.table==='directory.family_memberships'&&r.values.family_id===family&&r.values.relationship==='child').map(r=>r.values.person_id);
  const ids=rows.filter(r=>r.table==='directory.class_memberships'&&children.includes(r.values.person_id)).map(r=>r.values.class_id);
  return rows.filter(r=>r.table==='directory.classes'&&ids.includes(r.values.id)).map(r=>r.values.code).sort();
 };
 assert.deepEqual(classesFor(a),['DEMO-1A','DEMO-1B']);
 assert.deepEqual(classesFor(b),['DEMO-2A']);
 assert(rows.filter(r=>r.table==='directory.person_roles').every(r=>r.values.role!=='admin'));
});

test('separate admin setup requires an explicit non-parent inbox and never verifies ownership', async()=>{
 const {buildAdminPlan}=await import('./seed-demo-admin.mjs');
 assert.throws(()=>buildAdminPlan(),/distinct/);
 assert.throws(()=>buildAdminPlan({DEMO_ADMIN_EMAIL:'smzwaldorf.education@gmail.com'}),/distinct/);
 assert.throws(()=>buildAdminPlan({DEMO_ADMIN_EMAIL:'admin@example.test',NODE_ENV:'production'}),/real controlled/);
 const rows=buildAdminPlan({DEMO_ADMIN_EMAIL:'admin@example.test'});
 assert.equal(rows.find(r=>r.table==='auth.user').values.email_verified,false);
 assert.equal(rows.find(r=>r.table==='directory.login_invitations').values.status,'pending');
 assert.equal(rows.find(r=>r.table==='directory.person_roles').values.role,'admin');
});
