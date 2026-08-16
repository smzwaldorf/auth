import { describe, expect, it } from "vitest";

import { appBLogoutUrl, parseLogoutReturn } from "./logout-coordinator.js";

describe("global logout coordinator", () => {
  it("accepts only the two registered first-party return targets", () => {
    expect(parseLogoutReturn("app-a")).toBe("app-a");
    expect(parseLogoutReturn("app-b")).toBe("app-b");
    expect(parseLogoutReturn("https://example.com")).toBeUndefined();
    expect(parseLogoutReturn(undefined)).toBeUndefined();
  });

  it("routes through App B's local-session cleanup endpoint", () => {
    expect(appBLogoutUrl("app-a")).toBe("http://localhost:4000/logout/local?returnTo=app-a");
    expect(appBLogoutUrl("app-b")).toBe("http://localhost:4000/logout/local?returnTo=app-b");
  });
});
