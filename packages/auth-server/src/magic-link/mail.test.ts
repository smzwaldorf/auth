import { describe, expect, it, vi } from "vitest";
import { resendMailer } from "./mail.js";
import { parseRuntimeConfig } from "../runtime-config.js";
describe("login email delivery", () => {
  it("uses the approved sender and keeps credentials out of email content", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"sent"}'));
    await resendMailer(parseRuntimeConfig({ RESEND_API_KEY: "re_test" }), send)({ email: "test@example.invalid", url: "https://identity.test/link" });
    const [url, request] = send.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(request!.body as string)).toMatchObject({ from: "Aida <info@useaida.app>", to: ["test@example.invalid"], text: expect.stringContaining("https://identity.test/link") });
    expect(request!.body).not.toContain("re_test");
  });
  it("fails on missing credentials and provider errors without exposing provider details", async () => {
    const mail = { email: "test@example.invalid", url: "https://identity.test/link" };
    await expect(resendMailer(parseRuntimeConfig({}))(mail)).rejects.toThrow("not configured");
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider detail", { status: 403 }));
    await expect(resendMailer(parseRuntimeConfig({ RESEND_API_KEY: "re_test" }), send)(mail)).rejects.toThrow("Login email delivery failed");
  });
});
