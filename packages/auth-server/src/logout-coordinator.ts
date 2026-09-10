export type LogoutReturn = "app-a" | "app-b";

export function parseLogoutReturn(value: string | undefined): LogoutReturn | undefined {
  return value === "app-a" || value === "app-b" ? value : undefined;
}

export function appBLogoutUrl(returnTo: LogoutReturn, appBOrigin = "http://localhost:4000"): string {
  const destination = new URL("/logout/local", appBOrigin);
  destination.searchParams.set("returnTo", returnTo);
  return destination.toString();
}
