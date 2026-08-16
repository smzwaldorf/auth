export type LogoutReturn = "app-a" | "app-b";

export function parseLogoutReturn(value: string | undefined): LogoutReturn | undefined {
  return value === "app-a" || value === "app-b" ? value : undefined;
}

export function appBLogoutUrl(returnTo: LogoutReturn): string {
  const destination = new URL("http://localhost:4000/logout/local");
  destination.searchParams.set("returnTo", returnTo);
  return destination.toString();
}
