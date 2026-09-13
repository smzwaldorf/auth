import type { RuntimeConfig } from "../runtime-config.js";
export type LoginMail = { email: string; url: string };
export type LoginMailer = (mail: LoginMail) => Promise<void>;
export function resendMailer(config: RuntimeConfig, send: typeof fetch = fetch): LoginMailer {
  return async ({ email, url }) => {
    if (!config.RESEND_API_KEY) throw new Error("Login email delivery is not configured");
    const response = await send("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.MAGIC_LINK_FROM, to: [email], subject: "Sign in to SMZ",
        text: `Sign in to SMZ using this link:\n\n${url}\n\nThis link expires in five minutes and can be used once. If you did not request it, ignore this email.` }),
    });
    // Provider response bodies may contain recipient details; never log them.
    if (!response.ok) throw new Error("Login email delivery failed");
  };
}
