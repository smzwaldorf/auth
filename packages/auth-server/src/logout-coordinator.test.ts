import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { logoutPlan, parseLogoutReturn, renderLogoutPage, type LogoutRegistration } from "./logout-coordinator.js";

const registrations: LogoutRegistration[] = [
  { clientId: "vite-app", displayName: "App A", publicOrigin: "http://localhost:5173", postLogoutRedirectUris: ["http://localhost:5173/"], metadata: { frontChannelLogoutUri: "http://localhost:5173/logout/local" } },
  { clientId: "express-app", displayName: "App B", publicOrigin: "http://localhost:4000", postLogoutRedirectUris: ["http://localhost:4000/"], metadata: { frontChannelLogoutUri: "http://localhost:4000/logout/local" } },
  { clientId: "email-cms", displayName: "CMS", publicOrigin: "http://localhost:5174", postLogoutRedirectUris: ["http://localhost:5174/login"], metadata: { frontChannelLogoutUri: "http://localhost:5174/logout/local" } },
];
function pageHarness() {
  const elements = new Map<string, { textContent?: string; href?: string; hidden?: boolean; appendChild(child: unknown): void }>();
  for (const id of ["results", "status", "continue"]) elements.set(id, { appendChild() {} });
  const frames: Array<{ contentWindow: object; remove(): void; src?: string }> = [];
  const timers: Array<() => void> = [], redirects: string[] = [];
  let listener: (event: { source: object; origin: string; data: unknown }) => void = () => {};
  const document = { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => tag === "iframe" ? { contentWindow: {}, remove() {} } : {}, body: { appendChild: (frame: typeof frames[number]) => frames.push(frame) } };
  const window = { addEventListener: (_type: string, callback: typeof listener) => { listener = callback; }, location: { replace: (url: string) => redirects.push(url) } };
  const page = renderLogoutPage(logoutPlan(registrations, "email-cms")!, "test-state");
  vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)![1]!, { document, window, URL, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout() {} });
  return { frames, timers, redirects, elements, message: (source: object, origin: string, state = "test-state") => listener({ source, origin, data: { type: "smz:logout-complete", state } }) };
}

describe("registered global logout coordinator", () => {
  it("preserves legacy aliases and requires registered return origins", () => {
    expect(parseLogoutReturn("app-a")).toBe("vite-app");
    expect(parseLogoutReturn("app-b")).toBe("express-app");
    expect(parseLogoutReturn("https://attacker.example")).toBeUndefined();
    expect(logoutPlan(registrations, "email-cms")?.returnUrl).toBe("http://localhost:5174/login");
    expect(logoutPlan(registrations, "unknown")).toBeUndefined();
    expect(logoutPlan([{ ...registrations[0]!, postLogoutRedirectUris: ["https://attacker.example/"] }], "vite-app")).toBeUndefined();
  });
  it("never loads an unregistered, credentialed or query-bearing cleanup URL", () => {
    for (const uri of ["https://attacker.example/logout", "http://user:pass@localhost:5173/logout", "http://localhost:5173/logout?return=https://attacker.example", "javascript:alert(1)"]) {
      const plan = logoutPlan([{ ...registrations[0]!, metadata: { frontChannelLogoutUri: uri } }], "vite-app")!;
      expect(plan.targets).toHaveLength(0); expect(plan.unavailable).toEqual(["App A"]);
    }
  });
  it("requires exact frame source, origin and state before acknowledging cleanup", () => {
    const page = pageHarness();
    const source = page.frames[0]!.contentWindow;
    page.message({}, "http://localhost:5173");
    page.message(source, "http://attacker.example");
    page.message(source, "http://localhost:5173", "wrong-state");
    expect(page.redirects).toHaveLength(0);
    for (let i = 0; i < page.frames.length; i++) page.message(page.frames[i]!.contentWindow, registrations[i]!.publicOrigin!);
    expect(page.redirects).toEqual(["http://localhost:5174/login"]);
  });
  it("reports unreachable cleanup honestly and offers only the registered continuation", () => {
    const page = pageHarness(); page.timers.forEach((timer) => timer());
    expect(page.redirects).toHaveLength(0);
    expect(page.elements.get("status")?.textContent).toContain("Local cleanup could not be confirmed");
    expect(page.elements.get("continue")?.href).toBe("http://localhost:5174/login");
  });
});
