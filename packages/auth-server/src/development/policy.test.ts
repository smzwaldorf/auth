import { describe, expect, it } from "vitest";
import { developmentLoginEnabled, localDevelopmentRequest } from "./policy.js";

const config = { NODE_ENV: "development", ENABLE_DEV_LOGIN: "true", DEV_LOGIN_DATABASE_NAME: "smz_identity_dev", DATABASE_URL: "postgres://test:test@localhost:5432/smz_identity_dev", AUTH_ISSUER: "http://localhost:3000/api/auth" };
function request(headers: Record<string, string> = {}, url = "http://localhost:3000/api/auth/sign-in/development") {
  return new Request(url, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", ...headers } });
}
describe("development login boundaries", () => {
  it("requires every deployment opt-in", () => {
    expect(developmentLoginEnabled(config)).toBe(true);
    for (const patch of [ { ENABLE_DEV_LOGIN: "false" }, { NODE_ENV: "test" }, { NODE_ENV: "production" }, { DEV_LOGIN_DATABASE_NAME: "" }, { DATABASE_URL: "postgres://test:test@localhost/smz_identity" }, { DATABASE_URL: "postgres://test:test@remote.example/smz_identity_dev" }, { AUTH_ISSUER: "http://identity.example/api/auth" }, { AUTH_ISSUER: "https://localhost:3000/api/auth" } ]) expect(developmentLoginEnabled({ ...config, ...patch })).toBe(false);
  });
  it("requires trusted loopback socket, exact Host, exact Origin and direct deployment", () => {
    expect(localDevelopmentRequest(config, request(), "127.0.0.1")).toBe(true);
    for (const remote of [undefined, "192.168.1.2"]) expect(localDevelopmentRequest(config, request(), remote)).toBe(false);
    const rejectedHeaders: Record<string, string>[] = [{ host: "" }, { host: "attacker.example" }, { origin: "" }, { origin: "null" }, { origin: "http://localhost:5174" }, { "sec-fetch-site": "cross-site" }, { forwarded: "for=127.0.0.1" }, { "x-forwarded-host": "localhost:3000" }, { "x-real-ip": "127.0.0.1" }];
    for (const headers of rejectedHeaders) expect(localDevelopmentRequest(config, request(headers), "127.0.0.1")).toBe(false);
    expect(localDevelopmentRequest(config, request({}, "http://attacker.example/api/auth/sign-in/development"), "127.0.0.1")).toBe(false);
  });
});
