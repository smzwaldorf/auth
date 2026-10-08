import { escape as e } from "../admin/views.js";
import { badge, field, hidden, values } from "./views.js";
import type { familyProfileService } from "./service.js";
import type { AdultRow } from "./family-bundle.js";
const relationships = { father: "父親", mother: "母親", guardian: "監護人" };
type FamilyView = Awaited<ReturnType<ReturnType<typeof familyProfileService>["profile"]>>;
function adultCard(adult: AdultRow, index: string) {
  const prefix = `adult-${index}-`;
  return `<fieldset class="adult-row ${adult.removed ? 'is-removed' : ''}" data-existing="${adult.id ? 'true' : 'false'}"><legend>${adult.id ? e(adult.data.displayName) : '新增家長／監護人'}</legend>${hidden(`${prefix}id`, adult.id ?? '')}${hidden(`${prefix}removed`, String(adult.removed))}<div class="adult-toolbar"><span class="remove-notice">核准後將移出此家庭</span><button type="button" class="secondary remove-adult">${adult.removed ? '復原' : '移除'}</button></div><div class="adult-fields"><div class="field"><label for="${prefix}relationship">家庭關係</label><select id="${prefix}relationship" name="${prefix}relationship">${Object.entries(relationships).map(([key, label]) => `<option value="${key}" ${key === adult.relationship ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${['displayName','contactPhone','contactEmail'].map(k => field(k, adult.data[k as keyof AdultRow['data']], 'person', prefix).replace(`name="${k}"`, `name="${prefix}${k}"`)).join('')}</div></fieldset>`;
}
export function adultSummary(data: Record<string, any>) {
  if (!Array.isArray(data.adults)) return '';
  return `<div class="adult-summary">${data.adults.map((a: AdultRow) => {
    const before = data.baselineAdults?.find((b: AdultRow) => b.id === a.id);
    return `<article class="member"><h3>${e(a.removed && before ? before.data.displayName : a.data.displayName)} <span class="badge">${a.removed ? '移出家庭' : !before ? '新增成人' : '家長資料'}</span></h3><p>${e(relationships[a.relationship])}</p>${before ? `<details><summary>變更前</summary>${values(before.data, 'person')}<p>${e(relationships[before.relationship as keyof typeof relationships])}</p></details>` : ''}${a.removed ? '<p>核准後解除家庭關係，保留個人資料與歷史紀錄。</p>' : values(a.data, 'person')}</article>`;
  }).join('')}</div>`;
}
export function familyDetails(p: FamilyView, editRequested: boolean) {
  const url = `/profiles/family/${p.family.id}`;
  const canEdit = p.canEditBundle && (!p.hasOpenRequest || !!p.openRequest && ['draft', 'returned'].includes(p.openRequest.status));
  const editing = editRequested && canEdit;
  const adults = [...p.adults].sort((a,b) => ['father','mother','guardian'].indexOf(a.relationship) - ['father','mother','guardian'].indexOf(b.relationship));
  const display = `<section class="panel family-display" aria-label="目前家庭資料"><div class="panel-head"><h2>目前家庭資料</h2>${canEdit && !editing ? `<a class="button" href="${url}?edit=1#family-details">編輯資料</a>` : `<span class="badge">第 ${p.profile.revision} 版</span>`}</div><p class="request-intro">以下為目前已核准的資料。</p>${values(p.profile.data,'family')}<div class="section-heading"><h3>家長與監護人</h3></div>${adults.map(a => `<article class="member"><h3>${e(a.data.displayName)} <span class="relationship">${e(relationships[a.relationship])}</span></h3>${values(a.data,'person',['contactPhone','contactEmail'])}</article>`).join('')}${p.openRequest?.status === 'returned' ? '<p class="notice returned">申請已退回，請按「編輯資料」修正後重新送出。</p>' : ''}${p.canEdit && !p.canEditBundle ? '<p class="notice">目前無法編輯此人的個人資料，請聯絡學校確認權限。</p>' : ''}</section>`;
  if (editing) return `<div id="family-details" class="family-details is-editing">${display}<div class="family-editor"><div class="editor-toolbar"><a href="${url}#family-details">取消編輯</a></div>${unifiedFamilyForm(p)}</div></div>`;
  return `<div id="family-details" class="family-details">${display}${p.hasOpenRequest && (!p.openRequest || p.openRequest.status === 'pending') ? unifiedFamilyForm(p) : ''}</div>`;
}

export function unifiedFamilyForm(p: FamilyView) {
  const r = p.openRequest;
  const url = `/profiles/family/${p.family.id}`;
  if (p.hasOpenRequest && !r) return '<section class="panel"><h2>已有進行中的申請</h2><p>請待目前申請處理完成後再更新家庭資料。</p></section>';
  if (r?.status === 'pending') {
    const actionForm = (action: string, title: string, required = false) => `<form method="post" action="${url}/${action}">${hidden('requestId',r.id)}${hidden('version',r.version)}${hidden('submissionVersion',r.submission_version)}${action !== 'withdraw' ? `<div class="field"><label for="family-${action}-reason">審核說明${required ? '（必填）' : '（選填）'}</label><textarea id="family-${action}-reason" name="reason" maxlength="1000" ${required ? 'required' : ''}></textarea></div>` : ''}<button class="${action === 'approve' ? '' : 'secondary'}">${title}</button></form>`;
    return `<section class="panel unified-family"><div class="panel-head"><h2>家庭資料變更</h2>${badge('pending')}</div><p>整份家庭資料已送出，核准後將一起更新。</p>${values(r.data,'family')}${adultSummary(r.data)}${r.reason ? `<p>申請說明：${e(r.reason)}</p>` : ''}${p.canReview ? `<div class="review-actions">${actionForm('approve','核准全部變更')}${actionForm('return','退回修改',true)}${actionForm('reject','不核准',true)}</div>` : ''}${p.canEdit ? `<div class="withdraw">${actionForm('withdraw','撤回申請')}</div>` : ''}</section>`;
  }
  if (!p.canEditBundle) return `<section class="panel"><h2>家庭資料</h2>${values(p.profile.data,'family')}${p.adults.map(a => `<article class="member"><h3>${e(a.data.displayName)}</h3>${values(a.data,'person')}</article>`).join('')}${p.canEdit ? '<p class="notice">目前無法編輯此人的個人資料，請聯絡學校確認權限。</p>' : ''}</section>`;
  const proposed: AdultRow[] = Array.isArray(r?.data.adults) ? r.data.adults : [];
  const adults: AdultRow[] = [...p.adults].sort((a,b) => ['father','mother','guardian'].indexOf(a.relationship) - ['father','mother','guardian'].indexOf(b.relationship)).map(a => proposed.find(v => v.id === a.id) ?? { id: a.id, relationship: a.relationship, removed: false, data: a.data });
  adults.push(...proposed.filter(a => a.id === null));
  const data = r?.data ?? p.profile.data;
  const feedback = r && p.events.find(ev => ev.request_id === r.id && ev.action === 'return');
  return `<section class="panel unified-family"><h2>編輯家庭資料</h2><p class="request-intro">一次填寫家庭及所有家長資料，完成後送出審核。核准前，正式資料保持不變。</p>${feedback ? `<p class="notice returned">${e(feedback.reason)}</p>` : ''}<form method="post" action="${url}/submit-all" id="family-form">${hidden('requestId',r?.id ?? crypto.randomUUID())}${hidden('version',r?.version ?? 0)}${hidden('submissionVersion',r?.submission_version ?? 0)}${hidden('baseRevision',p.profile.revision)}${hidden('rosterVersion',p.rosterVersion)}<div class="fields">${field('mailingAddress',data.mailingAddress,'family')}${field('contactPhone',data.contactPhone,'family')}</div><div class="section-heading"><h3>家長與監護人</h3><p>可新增成人或移除現有家庭關係；家庭至少需保留一位成人。</p></div><div id="adult-rows">${adults.map((a,i) => adultCard(a,String(i))).join('')}</div><button type="button" class="secondary" id="add-adult">＋ 新增家長／監護人</button><div class="field family-reason"><label for="family-reason">變更說明（選填）</label><textarea id="family-reason" name="reason" rows="3" maxlength="1000">${e(r?.reason ?? '')}</textarea></div><p class="hint">新增成人不會建立登入帳號；聯絡信箱不會變更登入信箱。</p><p role="alert" id="family-form-error"></p><div class="actions"><button type="submit">送出全部變更</button></div></form><template id="adult-template">${adultCard({ id:null, relationship:'guardian', removed:false, data:{displayName:'',contactPhone:'',contactEmail:''}},'__INDEX__')}</template></section>`;
}
export const familyFormScript = `(() => {
 const form = document.getElementById('family-form'); if (!form) return;
 const rows = document.getElementById('adult-rows'); let index = rows.children.length;
 const error = document.getElementById('family-form-error');
 document.getElementById('add-adult').addEventListener('click', () => {
   if (rows.children.length >= 30) { error.textContent = '最多可填寫 30 位成人。'; return; }
   const template = document.getElementById('adult-template');
   const holder = document.createElement('template'); holder.innerHTML = template.innerHTML.replaceAll('__INDEX__', String(index++));
   rows.append(holder.content.cloneNode(true)); rows.lastElementChild.querySelector('input[type=text]').focus();
 });
 rows.addEventListener('click', event => {
   const button = event.target.closest('.remove-adult'); if (!button) return;
   const row = button.closest('.adult-row');
   if (row.dataset.existing === 'false') { row.remove(); return; }
   const removed = !row.classList.contains('is-removed'); row.classList.toggle('is-removed', removed);
   if (removed) row.querySelectorAll('.adult-fields input').forEach(input => { input.value = input.defaultValue; });
   row.querySelector('input[name$="-removed"]').value = String(removed); button.textContent = removed ? '復原' : '移除';
 });
 form.addEventListener('submit', event => {
   if (![...rows.children].some(row => !row.classList.contains('is-removed'))) {
     event.preventDefault(); error.textContent = '家庭至少需保留一位家長或監護人。'; error.scrollIntoView({block:'center'});
   }
 });
})();`;
