import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createApp: vi.fn(),
  createDatabase: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("./app.js", () => ({ createApp: mocks.createApp }));
vi.mock("./db/database.js", () => ({ createDatabase: mocks.createDatabase }));
vi.mock("./runtime-config.js", () => ({ parseRuntimeConfig: vi.fn(() => ({ environment: "production" })) }));

import worker from "./worker.js";

const env = {
  HYPERDRIVE: { connectionString: "postgres://hyperdrive.test/smz" },
  AUTH_ISSUER: "https://auth.school.test/api/auth",
  APP_A_ORIGIN: "https://app-a.school.test",
  APP_B_ORIGIN: "https://app-b.school.test",
  BETTER_AUTH_SECRET: "s".repeat(32),
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  APP_B_CLIENT_SECRET: "b".repeat(32),
};

describe("Auth Worker runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let requestNumber = 0;
    mocks.createDatabase.mockImplementation(() => ({ db: { requestNumber: ++requestNumber }, close: mocks.close }));
    mocks.createApp.mockImplementation((_config, database) => ({
      fetch: vi.fn(async () => {
        await Promise.resolve();
        return new Response(String(database.requestNumber));
      }),
    }));
  });

  it("reuses the Better Auth app while keeping database pools request scoped", async () => {
    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://auth.school.test/health"), env),
      worker.fetch(new Request("https://auth.school.test/api/auth/oauth2/token", { method: "POST" }), env),
    ]);

    expect(await first.text()).toBe("1");
    expect(await second.text()).toBe("2");
    expect(mocks.createDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.createApp).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
