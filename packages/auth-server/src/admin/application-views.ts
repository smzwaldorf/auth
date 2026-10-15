import type { applicationService } from "./application-service.js";
import { emptyState, escape, layout, notice, pageHead, pill } from "./views.js";
import { siteOrigin } from "./sites.js";
import { t, tn } from "./i18n.js";
type Service = ReturnType<typeof applicationService>;
export function applicationsView(data: Awaited<ReturnType<Service["list"]>>, nonce: string) {
  const count = data.registrations.length;
  const table = count ? `<table><thead><tr><th scope="col">${escape(t("Application"))}</th><th scope="col">${escape(t("Site URL"))}</th><th scope="col">${escape(t("Type"))}</th><th scope="col">${escape(t("Status"))}</th><th scope="col">首頁清單</th><th scope="col" class="right">${escape(t("Setup"))}</th></tr></thead><tbody>${data.registrations.map(app => {
    const origin = siteOrigin(app.publicOrigin || "");
    const enabled = app.enabled && app.oauthDisabled === false;
    return `<tr><td><a class="name" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">${escape(app.displayName)}</a><small>${escape(app.clientId)}</small></td><td>${origin ? `<a href="${escape(origin)}" target="_blank" rel="noopener noreferrer">${escape(origin)}</a>` : pill(t("Site URL needed"), "warn")}</td><td>${escape(app.publicClient === true ? t("Browser") : app.publicClient === false ? t("Server") : t("Not configured"))}</td><td>${pill(enabled ? t("Enabled") : t("Disabled"), enabled ? "ok" : "off")}</td><td><button type="button" class="secondary sm" role="switch" aria-checked="${app.showInLauncher}" aria-label="${escape(app.displayName)}：首頁顯示" data-visibility="${escape(app.clientId)}" data-version="${escape(app.version)}">${app.showInLauncher ? "顯示" : "隱藏"}</button><small role="status" aria-live="polite"></small></td><td class="right"><a class="btn ghost sm" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">顯示設定 / OIDC</a></td></tr>`;
  }).join("")}</tbody></table>` : emptyState(t("No applications registered yet"), `<p><a href="/admin/applications/new">${escape(t("Register your first application"))}</a>.</p>`);
  return layout(t("Applications"), `${pageHead({ eyebrow: t("Integrations"), title: t("Applications"), lede: escape(t("Registered OIDC clients. All approved, active adults automatically have access to every enabled application; each application enforces its own permissions.")), actions: `<a class="btn secondary" href="/">${escape(t("Open launcher"))}</a><a class="btn" href="/admin/applications/new">+ ${escape(t("Register application"))}</a>` })}
${notice(t("No per-user grants are required. Disable a user or end their login approval under Users to remove access across every application."), "info")}
<section class="card table-card" aria-labelledby="connected-applications"><h2 id="connected-applications" style="position:absolute;left:-9999px">${escape(t("Connected applications"))}</h2>${table}</section><p class="muted">${escape(tn(count, "{n} registered application", "{n} registered applications"))}. ${escape(t("Status reflects registration availability, not a live connection check."))}</p><script nonce="${escape(nonce)}">${visibilityScript}</script>`, true, "applications");
}

export const visibilityScript = `document.querySelectorAll('[data-visibility]').forEach(button => {
  let savedTimer;
  button.addEventListener('click', async () => {
    clearTimeout(savedTimer);
    const status = button.nextElementSibling;
    const desired = button.getAttribute('aria-checked') !== 'true';
    button.disabled = true;
    status.textContent = '儲存中…';
    try {
      const response = await fetch('/admin/applications/visibility/' + encodeURIComponent(button.dataset.visibility), {
        method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showInLauncher: desired, version: button.dataset.version })
      });
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('請重新載入頁面並確認登入狀態。');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '儲存失敗，請重新載入頁面確認狀態。');
      button.setAttribute('aria-checked', String(result.showInLauncher));
      button.dataset.version = result.version;
      button.textContent = result.showInLauncher ? '顯示' : '隱藏';
      status.textContent = '已儲存';
      savedTimer = setTimeout(() => { status.textContent = ''; }, 2000);
      button.disabled = false;
    } catch (error) {
      status.textContent = error.message || '無法確認儲存結果，請重新載入頁面。';
    }
  });
});`;
