import { describe, expect, it } from "vitest";
import { browserSignInError } from "./sign-in-error.js";

describe("browser sign-in errors", () => {
  it("shows school assistance without leaking error details and keeps status and cookies", async () => {
    const response = browserSignInError(new Request("http://localhost:3000/api/auth/callback/google", { headers: { accept: "text/html" } }),
      Response.json({ error: "access_denied", message: "private account details" }, { status: 403, headers: { "set-cookie": "state=; Max-Age=0" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const html = await response.text();
    expect(html).toContain("contact your school administrator");
    expect(html).not.toContain("private account details");
    expect(html).not.toContain("<nav>");
  });
  it("preserves JSON for API callers and token endpoints", () => {
    for (const [path, accept] of [["/api/auth/sign-in/social", "application/json"], ["/api/auth/oauth2/token", "text/html"], ["/api/directory/v1/me/access-context", "text/html"]]) {
      const response = Response.json({ error: "access_denied" }, { status: 403 });
      expect(browserSignInError(new Request(`http://localhost:3000${path}`, { headers: { accept: accept! } }), response)).toBe(response);
    }
  });
});
