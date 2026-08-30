import { WebStorageStateStore, UserManager } from "oidc-client-ts";

declare const __SMZ_AUTH_ISSUER__: string;
declare const __SMZ_TAILSCALE_HOST__: string;
declare const __SMZ_TAILSCALE_IP__: string;
declare const __SMZ_TAILSCALE_APP_A_PORT__: string;
declare const __SMZ_TAILSCALE_APP_B_PORT__: string;

const browserOrigin = new URL(window.location.origin);

function serviceOrigin(port: number): string {
  const destination = new URL(browserOrigin);
  if (browserOrigin.hostname === __SMZ_TAILSCALE_HOST__ && port === 4000) {
    destination.protocol = "https:";
    destination.port = __SMZ_TAILSCALE_APP_B_PORT__;
  } else {
    destination.port = String(port);
  }
  destination.pathname = "";
  destination.search = "";
  destination.hash = "";
  return destination.origin;
}

export const appBOrigin = serviceOrigin(4000);
export const authIssuer = __SMZ_AUTH_ISSUER__.replace(/\/$/, "");
export const authServiceOrigin = new URL(authIssuer).origin;
const directoryResource = new URL("/api/directory/v1", authServiceOrigin).href.replace(/\/$/, "");
const oidcCallbackOrigin = browserOrigin.hostname === __SMZ_TAILSCALE_IP__ && __SMZ_TAILSCALE_HOST__
  ? new URL(`https://${__SMZ_TAILSCALE_HOST__}:${__SMZ_TAILSCALE_APP_A_PORT__}`)
  : browserOrigin;

export const auth = new UserManager({
  authority: authIssuer,
  client_id: "vite-app",
  redirect_uri: new URL("/callback", oidcCallbackOrigin).href,
  post_logout_redirect_uri: new URL("/", oidcCallbackOrigin).href,
  response_type: "code",
  scope: "openid profile email directory:access offline_access",
  resource: directoryResource,
  extraTokenParams: { resource: directoryResource },
  loadUserInfo: true,
  automaticSilentRenew: false,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

auth.events.addAccessTokenExpiring(() => {
  void auth.signinSilent({
    resource: directoryResource,
    extraTokenParams: { resource: directoryResource },
  }).catch(async () => {
    await auth.removeUser();
  });
});
