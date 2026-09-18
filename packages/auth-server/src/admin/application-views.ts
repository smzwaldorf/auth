import type { applicationService } from "./application-service.js";
import { emptyState, escape, layout, notice, pageHead, pill } from "./views.js";
import { siteOrigin } from "./sites.js";
type Service = ReturnType<typeof applicationService>;
export function applicationsView(data: Awaited<ReturnType<Service["list"]>>) {
  const count = data.registrations.length;
  const table = count ? `<table><thead><tr><th scope="col">Application</th><th scope="col">Site URL</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col" class="right">Setup</th></tr></thead><tbody>${data.registrations.map(app => {
    const origin = siteOrigin(app.publicOrigin || "");
    const enabled = app.enabled && app.oauthDisabled === false;
    return `<tr><td><a class="name" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">${escape(app.displayName)}</a><small>${escape(app.clientId)}</small></td><td>${origin ? `<a href="${escape(origin)}" target="_blank" rel="noopener noreferrer">${escape(origin)}</a>` : pill("Site URL needed", "warn")}</td><td>${app.publicClient === true ? "Browser" : app.publicClient === false ? "Server" : "Not configured"}</td><td>${pill(enabled ? "Enabled" : "Disabled", enabled ? "ok" : "off")}</td><td class="right"><a class="btn ghost sm" href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">OIDC settings</a></td></tr>`;
  }).join("")}</tbody></table>` : emptyState("No applications registered yet", '<p><a href="/admin/applications/new">Register your first application</a>.</p>');
  return layout("Applications", `${pageHead({ eyebrow: "Integrations", title: "Applications", lede: "Registered OIDC clients. All approved, active adults automatically have access to every enabled application; each application enforces its own permissions.", actions: `<a class="btn secondary" href="/">Open launcher</a><a class="btn" href="/admin/applications/new">+ Register application</a>` })}
${notice("No per-user grants are required. Disable a user or end their login approval under Users to remove access across every application.", "info")}
<section class="card table-card" aria-labelledby="connected-applications"><h2 id="connected-applications" style="position:absolute;left:-9999px">Connected applications</h2>${table}</section><p class="muted">${count} registered application${count === 1 ? "" : "s"}. Status reflects registration availability, not a live connection check.</p>`, true, "applications");
}
