import type { applicationService } from "./application-service.js";
import { emptyState, escape, layout, notice, pageHead, pill } from "./views.js";
import { siteOrigin } from "./sites.js";
import { t, tn } from "./i18n.js";
type Service = ReturnType<typeof applicationService>;
export function applicationsView(data: Awaited<ReturnType<Service["list"]>>) {
  const count = data.registrations.length;
  const table = count ? `<table><thead><tr><th scope="col">${escape(t("Application"))}</th><th scope="col">${escape(t("Site URL"))}</th><th scope="col">${escape(t("Type"))}</th><th scope="col">${escape(t("Status"))}</th><th scope="col" class="right">${escape(t("Setup"))}</th></tr></thead><tbody>${data.registrations.map(app => {
    const origin = siteOrigin(app.publicOrigin || "");
    const enabled = app.enabled && app.oauthDisabled === false;
    return `<tr><td><a class="name" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">${escape(app.displayName)}</a><small>${escape(app.clientId)}</small></td><td>${origin ? `<a href="${escape(origin)}" target="_blank" rel="noopener noreferrer">${escape(origin)}</a>` : pill(t("Site URL needed"), "warn")}</td><td>${escape(app.publicClient === true ? t("Browser") : app.publicClient === false ? t("Server") : t("Not configured"))}</td><td>${pill(enabled ? t("Enabled") : t("Disabled"), enabled ? "ok" : "off")}</td><td class="right"><a class="btn ghost sm" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">${escape(t("OIDC settings"))}</a></td></tr>`;
  }).join("")}</tbody></table>` : emptyState(t("No applications registered yet"), `<p><a href="/admin/applications/new">${escape(t("Register your first application"))}</a>.</p>`);
  return layout(t("Applications"), `${pageHead({ eyebrow: t("Integrations"), title: t("Applications"), lede: escape(t("Registered OIDC clients. All approved, active adults automatically have access to every enabled application; each application enforces its own permissions.")), actions: `<a class="btn secondary" href="/">${escape(t("Open launcher"))}</a><a class="btn" href="/admin/applications/new">+ ${escape(t("Register application"))}</a>` })}
${notice(t("No per-user grants are required. Disable a user or end their login approval under Users to remove access across every application."), "info")}
<section class="card table-card" aria-labelledby="connected-applications"><h2 id="connected-applications" style="position:absolute;left:-9999px">${escape(t("Connected applications"))}</h2>${table}</section><p class="muted">${escape(tn(count, "{n} registered application", "{n} registered applications"))}. ${escape(t("Status reflects registration availability, not a live connection check."))}</p>`, true, "applications");
}
