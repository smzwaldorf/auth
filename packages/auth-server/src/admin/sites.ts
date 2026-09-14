import { createHash } from "node:crypto";

export type SiteRegistration = { clientId: string; displayName: string; publicOrigin: string | null; enabled: boolean; oauthDisabled: boolean | null };
export function siteOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const admissionClient = (id: string) => id === "email-cms-server" ? "email-cms" : id;
export function siteCatalog(registrations: SiteRegistration[]) {
  const sorted = [...registrations].sort((a, b) => a.clientId.localeCompare(b.clientId));
  const groups = new Map<string, SiteRegistration[]>();
  const unlinked: SiteRegistration[] = [];
  for (const r of sorted) {
    const origin = siteOrigin(r.publicOrigin);
    if (!origin) { unlinked.push(r); continue; }
    groups.set(origin, [...groups.get(origin) ?? [], r]);
  }
  const sites = [...groups].map(([origin, clients]) => {
    const grantClientIds = [...new Set(clients.map(r => admissionClient(r.clientId)))].sort();
    const cmsServer = sorted.find(r => r.clientId === "email-cms-server");
    const cms = sorted.find(r => r.clientId === "email-cms");
    const cmsConflict = clients.some(r => ["email-cms", "email-cms-server"].includes(r.clientId)) && cmsServer && (!cms || siteOrigin(cms.publicOrigin) !== origin || siteOrigin(cmsServer.publicOrigin) !== origin);
    return { origin, clients, grantClientIds, clientIds: clients.map(r => r.clientId),
      canGrant: clients.some(r => r.enabled && !r.oauthDisabled),
      issue: cmsConflict ? "The CMS login clients must have the same configured site link before access can be managed." : null,
      version: fingerprint([clients, cmsConflict ? [cms, cmsServer] : null]),
    };
  }).sort((a, b) => a.origin.localeCompare(b.origin));
  return { sites, unlinked, version: fingerprint(sorted) };
}
export type Site = ReturnType<typeof siteCatalog>["sites"][number];
export function assignedSiteAccess(site: Site, activeClientIds: string[]): "granted" | "partial" | "not-granted" {
  const count = site.grantClientIds.filter(id => activeClientIds.includes(id)).length;
  return count === site.grantClientIds.length ? "granted" : count ? "partial" : "not-granted";
}
export const sitePath = (origin: string) => `/admin/applications/site?${new URLSearchParams({ url: origin })}`;
