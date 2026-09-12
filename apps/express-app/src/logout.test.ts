import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
const app = createApp(parseConfig({}, false));
const state = "12345678-1234-4234-8234-123456789012";
describe("registered front-channel logout", () => {
  it("rejects caller redirects and untrusted parents", async () => {
    for (const url of ["/logout/local?returnTo=app-a", `/logout/local?logout_state=${state}`]) {
      const response = await app.request(url, { headers: { referer: "https://attacker.example/" } });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });
  it("clears local cookies and acknowledges only the Auth parent", async () => {
    const response = await app.request(`/logout/local?logout_state=${state}`, { headers: { referer: "http://localhost:3000/logout-all/email-cms" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors http://localhost:3000");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const html = await response.text();
    expect(html).toContain('"smz:logout-complete"');
    expect(html).toContain(state);
    expect(html).not.toContain("window.location");
  });
});
