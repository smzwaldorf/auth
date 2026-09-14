import { layout } from "./admin/views.js";

export function signInErrorPage() {
  return layout("Unable to sign in", '<section class="card"><h1>Unable to sign in</h1><p>Your account may not be registered or approved to use this service, or your sign-in could not be completed.</p><p>Please contact your school administrator for assistance. Let them know the email address you used to sign in.</p><a class="button" href="/">Return to school applications</a></section>', false);
}

export function browserSignInError(request: Request, response: Response): Response {
  const path = new URL(request.url).pathname;
  const loginPath = path.startsWith("/api/auth/callback/") || path.startsWith("/api/auth/sign-in/") || path === "/api/auth/oauth2/authorize" || path === "/api/auth/error" || path === "/sign-in/google";
  const navigation = request.headers.get("sec-fetch-mode") === "navigate" || request.headers.get("accept")?.includes("text/html");
  if (!loginPath || !navigation || response.status < 400 || !response.headers.get("content-type")?.includes("application/json")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(signInErrorPage(), { status: response.status, headers });
}
