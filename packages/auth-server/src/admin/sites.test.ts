import { describe, expect, it } from "vitest";
import { assignedSiteAccess, siteCatalog, siteOrigin } from "./sites.js";
const registration = (clientId: string, publicOrigin: string | null) => ({ clientId, publicOrigin, displayName: clientId, enabled: true, oauthDisabled: false });
describe("site access grouping", () => {
  it("normalizes origins without grouping schemes, ports, or unconfigured sites together", () => {
    const catalog = siteCatalog([registration("a", "https://SCHOOL.example:443/"), registration("b", "https://school.example"), registration("c", "http://school.example"), registration("d", "https://school.example:8443"), registration("e", null), registration("f", "https://school.example/path")]);
    expect(catalog.sites).toHaveLength(3);
    expect(catalog.sites.find(s => s.origin === "https://school.example")?.clientIds).toEqual(["a", "b"]);
    expect(catalog.unlinked.map(r => r.clientId)).toEqual(["e", "f"]);
    for (const url of ["javascript:alert(1)", "https://user:pass@example.com", "https://example.com?x=1", "https://example.com/#x"]) expect(siteOrigin(url)).toBeNull();
  });
  it("preserves partial grants and includes disabled clients in the site-wide decision", () => {
    const group = siteCatalog([registration("a", "https://school.example"), { ...registration("b", "https://school.example"), enabled: false }]).sites[0]!;
    expect(group.canGrant).toBe(true);
    expect(assignedSiteAccess(group, ["a"])).toBe("partial");
    expect(assignedSiteAccess(group, ["a", "b"])).toBe("granted");
    expect(assignedSiteAccess(group, [])).toBe("not-granted");
  });
  it("uses stable fingerprints and rejects mismatched CMS site configuration", () => {
    const a = registration("email-cms", "https://cms.example"), b = registration("email-cms-server", "https://cms.example");
    expect(siteCatalog([a, b]).version).toBe(siteCatalog([b, a]).version);
    expect(siteCatalog([a, b]).sites[0]?.grantClientIds).toEqual(["email-cms"]);
    expect(siteCatalog([a, { ...b, publicOrigin: "https://other.example" }]).sites.every(s => s.issue)).toBe(true);
  });
});
