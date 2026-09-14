import type { applicationService } from "./application-service.js";
import { escape, layout } from "./views.js";
import { siteOrigin } from "./sites.js";
type Service = ReturnType<typeof applicationService>;
export function applicationsView(data: Awaited<ReturnType<Service["list"]>>) {
  const registrations = `<section aria-labelledby="connected-applications"><h2 id="connected-applications">Connected applications</h2><p>${data.registrations.length} registered application${data.registrations.length === 1 ? "" : "s"}. Status reflects registration availability, not a live connection check.</p><div class="card table">${data.registrations.length ? `<table><thead><tr><th scope="col">Application</th><th scope="col">Site URL</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>${data.registrations.map(app => {
    const origin = siteOrigin(app.publicOrigin || "");
    const enabled = app.enabled && app.oauthDisabled === false;
    return `<tr><td><strong>${escape(app.displayName)}</strong><small>${escape(app.clientId)}</small></td><td>${origin ? `<a href="${escape(origin)}" target="_blank" rel="noopener noreferrer">${escape(origin)}</a>` : '<span class="badge disabled">Site URL needed</span>'}</td><td>${app.publicClient === true ? "Browser" : app.publicClient === false ? "Server" : "Not configured"}</td><td><span class="badge ${enabled ? "" : "disabled"}">${enabled ? "Enabled" : "Disabled"}</span></td><td><div class="actions"><a href="/admin/applications/setup/${encodeURIComponent(app.clientId)}">Setup</a><small>Automatic access for approved users</small></div></td></tr>`;
  }).join("")}</tbody></table>` : '<div class="empty"><p>No applications registered yet.</p><a href="/admin/applications/new">Add your first application</a></div>'}</div></section>`;
  return layout("Applications", `<header><div><span class="eyebrow">Administration</span><h1>Applications</h1><p>All approved, active users automatically have access to every enabled application.</p></div><div class="actions"><a class="button secondary" href="/">Open apps</a><a href="/admin/applications/new">Add application →</a></div></header><div class="notice">No per-user grants are required. Disable a user or revoke login approval to remove their access across applications. Each application manages its own permissions.</div>${registrations}`);
}
