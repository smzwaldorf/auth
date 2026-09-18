import { readFileSync } from 'node:fs';
import { demoId as id, row, runSeed, isMain } from './demo-seed-support.mjs';
const demoFamilies = JSON.parse(readFileSync(new URL('./demo-families.json', import.meta.url), 'utf8'));
export function buildDemoPlan(env = {}) {
  const emails = ['DEMO_PARENT_A_EMAIL', 'DEMO_PARENT_B_EMAIL'].map((key, index) => (env[key] ?? (index === 0 ? demoFamilies.parentAEmail : demoFamilies.parentBEmail)).trim().toLowerCase());
  if (emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || emails[0] === emails[1]) throw Error('Set two distinct DEMO_PARENT_A_EMAIL / DEMO_PARENT_B_EMAIL addresses you control; use example.invalid addresses for an offline rehearsal');
  if (env.NODE_ENV === 'production' && (env.ENABLE_DEV_LOGIN === 'true' || emails.some(email => /\.(invalid|test)$/.test(email)))) throw Error('Production demo requires real controlled inboxes and development login disabled');
  const rows = [];
  const people = ['Demo Parent A', 'Demo Parent B', 'Demo Student 1A', 'Demo Student 1B', 'Demo Student 2A'];
  people.forEach((name, index) => {
    const personId = id(index + 1), adult = index < 2;
    rows.push(row('directory.people', 'id', { id: personId, kind: adult ? 'adult' : 'student', display_name: name, normalized_login_email: adult ? emails[index] : null }));
    rows.push(row('directory.person_roles', ['person_id', 'role'], { person_id: personId, role: adult ? 'parent' : 'student' }));
    if (adult) {
      rows.push(row('auth.user', 'id', { id: personId, name, email: emails[index], email_verified: false }));
      rows.push(row('directory.login_invitations', 'id', { id: id(51 + index), person_id: personId, normalized_email: emails[index], status: 'pending' }));
    }
  });
  for (let i = 0; i < 2; i++) rows.push(row('directory.families', 'id', { id: id(101 + i), code: `DEMO-FAMILY-${i ? 'B' : 'A'}`, display_name: `Demo Family ${i ? 'B' : 'A'}` }));
  [[1,101,'guardian'],[2,102,'guardian'],[3,101,'child'],[4,101,'child'],[5,102,'child']].forEach(([person,family,relationship],i) => rows.push(row('directory.family_memberships','id',{id:id(111+i),person_id:id(person),family_id:id(family),relationship})));
  ['1A','1B','2A'].forEach((label,i) => {
    rows.push(row('directory.classes','id',{id:id(201+i),code:`DEMO-${label}`,display_name:`Demo Grade ${label}`}));
    rows.push(row('directory.class_memberships','id',{id:id(211+i),class_id:id(201+i),person_id:id(3+i),relationship:'student'}));
  });
  rows.push(row('directory.audit_events','id',{id:id(901),event_type:'demo.seed.created',actor:'operator:seed-demo',detail:JSON.stringify({profile:'smz-newsletter-demo-v1'})}));
  return rows;
}
if (isMain(import.meta.url)) runSeed(buildDemoPlan, ['.env']).catch(error => { console.error(error.message); process.exitCode = 1; });
