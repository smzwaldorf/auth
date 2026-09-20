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
    mocks.createDatabase.mockReturnValue({ db: {}, close: mocks.close });
    mocks.createApp.mockReturnValue({ fetch: mocks.fetch });
    mocks.fetch.mockResolvedValue(new Response("ok"));
  });

  it("reuses the database and Better Auth app across requests in one isolate", async () => {
    await worker.fetch(new Request("https://auth.school.test/health"), env);
    await worker.fetch(new Request("https://auth.school.test/api/auth/oauth2/token", { method: "POST" }), env);

    expect(mocks.createDatabase).toHaveBeenCalledOnce();
    expect(mocks.createApp).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
