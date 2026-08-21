export type SignInFeedback = {
  tone: "info" | "error";
  message: string;
};

/**
 * Translates internal/provider outcomes into safe, actionable sign-in copy.
 * Do not surface provider error descriptions: they can be technical and may
 * disclose whether an email address is present in the school directory.
 */
export function getSignInFeedback(status?: string, providerError?: string): SignInFeedback | undefined {
  switch (status) {
    case "magic-link-sent":
      return { tone: "info", message: "If this address is approved, a sign-in link is on its way." };
    case "magic-link-delivery-failed":
      return { tone: "error", message: "We could not send a sign-in link right now. Try Google sign-in or contact the school." };
    case "magic-link-failed":
      return {
        tone: "error",
        message: providerError?.toLowerCase() === "invalid_token"
          ? "This sign-in link is invalid, expired, or has already been used. Request a new link."
          : "This sign-in link could not be completed. Request a new link and try again.",
      };
    case "google-unavailable":
      return { tone: "error", message: "Google sign-in is not available right now. Use an email link or contact the school." };
    case "google-failed":
      return {
        tone: "error",
        message: ["access_denied", "signup_disabled", "account_not_linked"].includes(providerError?.toLowerCase() ?? "")
          ? "Google sign-in was not completed. Choose the exact approved email for an active parent or teacher account, then try again."
          : "Google sign-in could not be completed. Try again or use an email link.",
      };
    case "development-login-unavailable":
      return { tone: "error", message: "That development account is no longer available for sign-in." };
    case "invalid-request":
      return { tone: "error", message: "This sign-in request is missing or has expired. Return to the app and try again." };
    case "admin-access-denied":
      return { tone: "error", message: "This account is not an active administrator. Use an approved administrator account or contact the school." };
    default:
      return providerError ? { tone: "error", message: "Sign-in could not be completed. Please try again." } : undefined;
  }
}

/**
 * An OAuth callback returns to the sign-in page with the original request in
 * `oauth_query`; the initial authorization request is the query itself.
 */
export function oauthQueryForSignInPage(url: URL): string {
  return url.searchParams.get("oauth_query") ?? url.search.slice(1);
}
