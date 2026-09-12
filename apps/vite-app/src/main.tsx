import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "oidc-client-ts";

import { auth } from "./auth";
import { authOrigin, appBOrigin, directoryResource } from "./config";
import "./styles.css";

const globalLogoutChannel = new BroadcastChannel("smz-global-logout");

type AccessContext = {
  sub: string;
  clientId: string;
  access: "active";
  roles: string[];
  familyMemberships: Array<{ familyId: string; relationship: string }>;
  relatedStudentIds: string[];
  classScopes: { parent: string[]; teacher: string[]; effective: string[] };
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [accessContext, setAccessContext] = useState<AccessContext>();

  useEffect(() => {
    async function clearLocalAuthentication() {
      try {
        await auth.revokeTokens(["access_token", "refresh_token"]);
      } catch {
        // Local state still has to be removed if the token is already invalid.
      }
      await auth.removeUser();
    }

    async function loadDirectory(currentUser: User | null) {
      setUser(currentUser);
      setError(undefined);
      setAccessContext(undefined);
      if (!currentUser?.access_token) {
        setAccessContext(undefined);
        return;
      }
      const response = await fetch(`${directoryResource}/me/access-context`, {
        headers: { Authorization: `Bearer ${currentUser.access_token}` },
      });
      if (!response.ok) throw new Error(`Directory access failed (${response.status})`);
      setAccessContext(await response.json() as AccessContext);
    }

    async function initialize() {
      try {
        if (window.location.pathname === "/logout-complete") {
          const returnTo = new URLSearchParams(window.location.search).get("returnTo");
          globalLogoutChannel.postMessage("logout");
          await clearLocalAuthentication();
          window.location.replace(returnTo === "app-b" ? `${appBOrigin}/` : "/");
          return;
        }
        if (window.location.pathname === "/callback") {
          await auth.signinRedirectCallback();
          window.history.replaceState({}, document.title, "/");
        }
        await loadDirectory(await auth.getUser());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Authentication failed");
      } finally {
        setLoading(false);
      }
    }

    const handleGlobalLogout = () => {
      void clearLocalAuthentication().finally(() => {
        setUser(null);
        setAccessContext(undefined);
      });
    };
    globalLogoutChannel.addEventListener("message", handleGlobalLogout);
    void initialize();

    const removeLoaded = auth.events.addUserLoaded((loadedUser) => {
      void loadDirectory(loadedUser).catch((caught) => setError(caught instanceof Error ? caught.message : "Directory access failed"));
    });
    const removeUnloaded = auth.events.addUserUnloaded(() => { setUser(null); setAccessContext(undefined); });
    const removeExpired = auth.events.addAccessTokenExpired(() => setUser(null));
    return () => {
      removeLoaded();
      removeUnloaded();
      removeExpired();
      globalLogoutChannel.removeEventListener("message", handleGlobalLogout);
    };
  }, []);

  const signedIn = Boolean(user && !user.expired);

  async function signOutEverywhere() {
    globalLogoutChannel.postMessage("logout");
    try {
      await auth.revokeTokens(["access_token", "refresh_token"]);
    } catch {
      // Continue through the logout chain even if a token was already revoked.
    }
    await auth.removeUser();
    window.location.assign(`${authOrigin}/logout-all/app-a`);
  }

  return (
    <main className="shell">
      <header>
        <div className="app-mark">A</div>
        <div>
          <span className="eyebrow">Public OIDC client</span>
          <h1>Vite App A</h1>
        </div>
      </header>

      <section className={`status ${signedIn ? "authenticated" : "anonymous"}`}>
        <div className="status-dot" />
        <div>
          <span className="eyebrow">Authentication status</span>
          <strong>{loading ? "Checking session…" : signedIn ? "Authenticated" : "Not authenticated"}</strong>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      {signedIn && user ? (
        <section className="profile">
          {typeof user.profile.picture === "string" ? (
            <img src={user.profile.picture} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="avatar">{String(user.profile.name ?? "U").slice(0, 1)}</div>
          )}
          <div>
            <h2>{String(user.profile.name ?? "Signed-in user")}</h2>
            <p>{String(user.profile.email ?? "No email claim")}</p>
          </div>
          <dl>
            <div><dt>Issuer</dt><dd>{user.profile.iss}</dd></div>
            <div><dt>Subject</dt><dd>{user.profile.sub}</dd></div>
            <div><dt>Client ID</dt><dd>vite-app</dd></div>
            <div><dt>Flow</dt><dd>Authorization Code + PKCE</dd></div>
            <div><dt>Directory access</dt><dd>{accessContext?.access ?? (error ? "unavailable" : "checking")}</dd></div>
            <div><dt>School roles</dt><dd>{accessContext?.roles.join(", ") || "none"}</dd></div>
            <div><dt>Class scopes</dt><dd>{accessContext?.classScopes.effective.join(", ") || "none"}</dd></div>
          </dl>
        </section>
      ) : (
        <section className="explanation">
          <h2>This app owns no passwords</h2>
          <p>It redirects to the shared auth service and receives an app-specific token after login.</p>
        </section>
      )}

      <div className="actions">
        {signedIn ? (
          <button className="secondary" onClick={() => void signOutEverywhere()}>Sign out</button>
        ) : (
          <button onClick={() => void auth.signinRedirect({ nonce: crypto.randomUUID() })}>Sign in through SMZ Auth</button>
        )}
        <a href={appBOrigin}>Open App B <span>↗</span></a>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
