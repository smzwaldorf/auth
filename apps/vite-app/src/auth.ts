import { WebStorageStateStore, UserManager } from "oidc-client-ts";

const directoryResource = "smz-directory";

export const auth = new UserManager({
  authority: "http://localhost:3000/api/auth",
  client_id: "vite-app",
  redirect_uri: "http://localhost:5173/callback",
  post_logout_redirect_uri: "http://localhost:5173/",
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
