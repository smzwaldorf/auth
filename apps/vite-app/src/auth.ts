import { WebStorageStateStore, UserManager } from "oidc-client-ts";

import { directoryResource, issuer } from "./config";

export const auth = new UserManager({
  authority: issuer,
  client_id: "vite-app",
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: `${window.location.origin}/`,
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
