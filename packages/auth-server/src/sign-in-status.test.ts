import { describe, expect, it } from "vitest";

import { getSignInFeedback, oauthQueryForSignInPage } from "./sign-in-status.js";

describe("sign-in status", () => {
  it("shows a safe failure when Google denies an unknown or ineligible email", () => {
    for (const providerError of ["access_denied", "signup_disabled", "account_not_linked"]) {
      expect(getSignInFeedback("google-failed", providerError)).toEqual({
      tone: "error",
      message: "Google sign-in was not completed. Choose the exact approved email for an active parent or teacher account, then try again.",
      });
    }
  });

  it("explains an expired or used magic link without exposing provider details", () => {
    expect(getSignInFeedback("magic-link-failed", "INVALID_TOKEN")?.message).toMatch(/invalid, expired, or has already been used/i);
  });

  it("covers delivery, provider, development, and invalid-request failures", () => {
    for (const status of ["magic-link-delivery-failed", "google-unavailable", "development-login-unavailable", "invalid-request", "admin-access-denied"]) {
      expect(getSignInFeedback(status)).toMatchObject({ tone: "error" });
    }
    expect(getSignInFeedback(undefined, "provider_error")).toEqual({
      tone: "error",
      message: "Sign-in could not be completed. Please try again.",
    });
  });

  it("retains the original OAuth request after returning from a provider", () => {
    const original = "response_type=code&client_id=vite-app&state=signed-state";
    const returned = new URL(`http://localhost:3000/sign-in?oauth_query=${encodeURIComponent(original)}&status=google-failed&error=access_denied`);
    expect(oauthQueryForSignInPage(returned)).toBe(original);
  });
});
