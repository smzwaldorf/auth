import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "oidc-client-ts";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import { auth } from "./auth";
import "@xyflow/react/dist/style.css";
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

type ArchitectureNodeData = {
  eyebrow: string;
  title: string;
  detail: string;
  tone: "person" | "identity" | "data" | "public" | "confidential";
  explanation: string;
};

type ArchitectureNode = Node<ArchitectureNodeData, "architecture">;

function ArchitectureNodeCard({ data, selected }: NodeProps<ArchitectureNode>) {
  return (
    <div className={`architecture-node ${data.tone} ${selected ? "is-selected" : ""}`}>
      <Handle id="target-left" type="target" position={Position.Left} />
      <Handle id="source-left" type="source" position={Position.Left} />
      <Handle id="target-right" type="target" position={Position.Right} />
      <Handle id="source-right" type="source" position={Position.Right} />
      <Handle id="target-top" type="target" position={Position.Top} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} />
      <span>{data.eyebrow}</span>
      <strong>{data.title}</strong>
      <small>{data.detail}</small>
    </div>
  );
}

const nodeTypes = { architecture: ArchitectureNodeCard };

const initialNodes: ArchitectureNode[] = [
  { id: "person", type: "architecture", position: { x: 0, y: 182 }, data: { eyebrow: "1 · PERSON", title: "School adult", detail: "Uses either client app", tone: "person", explanation: "Only pre-approved, active adults can authenticate. Students are directory records, not login users." } },
  { id: "google", type: "architecture", position: { x: 290, y: 0 }, data: { eyebrow: "IDENTITY PROOF", title: "Google OAuth", detail: "openid · profile · email", tone: "identity", explanation: "Google verifies the adult. Its token material stays encrypted at SMZ Identity and is never handed to either client app." } },
  { id: "identity", type: "architecture", position: { x: 570, y: 92 }, data: { eyebrow: "2 · CENTRAL ISSUER", title: "SMZ Identity", detail: "Hono + Better Auth · :3000", tone: "identity", explanation: "The shared authorization server validates the registered client and redirect URI, checks school admission, then issues an authorization code and tokens." } },
  { id: "directory", type: "architecture", position: { x: 570, y: 332 }, data: { eyebrow: "LIVE CONTEXT", title: "School directory", detail: "PostgreSQL · roles · memberships", tone: "data", explanation: "This is the live source for application access, roles, families, related students, and class scopes. It is checked both while issuing tokens and on every directory request." } },
  { id: "app-a", type: "architecture", position: { x: 930, y: 40 }, data: { eyebrow: "3A · PUBLIC CLIENT", title: "Vite App A", detail: "React browser app · :5173", tone: "public", explanation: "This browser-only app sends the authorization-code flow with PKCE S256. It keeps its tokens in session storage and calls the directory API with its access token." } },
  { id: "app-b", type: "architecture", position: { x: 930, y: 300 }, data: { eyebrow: "3B · CONFIDENTIAL CLIENT", title: "Express App B", detail: "Server app · :4000", tone: "confidential", explanation: "This server-side client also uses PKCE S256, but redeems and refreshes tokens on the server. The browser receives only App B's local application session." } },
];

const initialEdges: Edge[] = [
  { id: "person-a", source: "person", sourceHandle: "source-right", target: "app-a", targetHandle: "target-left", label: "opens App A", type: "smoothstep", style: { stroke: "#457ca9", strokeWidth: 2 }, labelStyle: { fill: "#457ca9", fontWeight: 700 }, labelBgStyle: { fill: "#f8fbff" } },
  { id: "person-b", source: "person", sourceHandle: "source-right", target: "app-b", targetHandle: "target-left", label: "or App B", type: "smoothstep", style: { stroke: "#7654a4", strokeWidth: 2 }, labelStyle: { fill: "#7654a4", fontWeight: 700 }, labelBgStyle: { fill: "#fcfaff" } },
  { id: "a-authorize", source: "app-a", sourceHandle: "source-left", target: "identity", targetHandle: "target-right", label: "authorize · state · PKCE S256", type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#457ca9", strokeWidth: 2 }, labelStyle: { fill: "#457ca9", fontWeight: 700 }, labelBgStyle: { fill: "#f8fbff" } },
  { id: "b-authorize", source: "app-b", sourceHandle: "source-left", target: "identity", targetHandle: "target-right", label: "authorize · client auth · PKCE", type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#7654a4", strokeWidth: 2 }, labelStyle: { fill: "#7654a4", fontWeight: 700 }, labelBgStyle: { fill: "#fcfaff" } },
  { id: "identity-google", source: "identity", sourceHandle: "source-left", target: "google", targetHandle: "target-right", label: "redirects to verify", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#d47b3f", strokeWidth: 2 }, labelStyle: { fill: "#a95b28", fontWeight: 700 }, labelBgStyle: { fill: "#fffaf5" } },
  { id: "identity-directory", source: "identity", sourceHandle: "source-bottom", target: "directory", targetHandle: "target-top", label: "checks active adult + app access", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#39806b", strokeWidth: 2 }, labelStyle: { fill: "#2c6b58", fontWeight: 700 }, labelBgStyle: { fill: "#f6fffb" } },
  { id: "a-tokens", source: "identity", sourceHandle: "source-right", target: "app-a", targetHandle: "target-left", label: "code → ID + access + refresh tokens", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#457ca9", strokeWidth: 2 }, labelStyle: { fill: "#457ca9", fontWeight: 700 }, labelBgStyle: { fill: "#f8fbff" } },
  { id: "b-tokens", source: "identity", sourceHandle: "source-right", target: "app-b", targetHandle: "target-left", label: "code → server-held tokens", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#7654a4", strokeWidth: 2 }, labelStyle: { fill: "#7654a4", fontWeight: 700 }, labelBgStyle: { fill: "#fcfaff" } },
  { id: "a-directory", source: "app-a", sourceHandle: "source-bottom", target: "directory", targetHandle: "target-top", label: "Bearer token → access context", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#39806b", strokeWidth: 2, strokeDasharray: "5 4" }, labelStyle: { fill: "#2c6b58", fontWeight: 700 }, labelBgStyle: { fill: "#f6fffb" } },
  { id: "b-directory", source: "app-b", sourceHandle: "source-left", target: "directory", targetHandle: "target-right", label: "server-side access-context call", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#39806b", strokeWidth: 2, strokeDasharray: "5 4" }, labelStyle: { fill: "#2c6b58", fontWeight: 700 }, labelBgStyle: { fill: "#f6fffb" } },
];

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [accessContext, setAccessContext] = useState<AccessContext>();
  const [selectedNodeId, setSelectedNodeId] = useState("identity");
  const selectedNode = initialNodes.find((node) => node.id === selectedNodeId) ?? initialNodes[2];
  const nodes = useMemo(() => initialNodes.map((node) => ({ ...node, selected: node.id === selectedNodeId })), [selectedNodeId]);

  useEffect(() => {
    async function clearLocalAuthentication() {
      try { await auth.revokeTokens(["access_token", "refresh_token"]); } catch { /* Clear local state even when a token is already invalid. */ }
      await auth.removeUser();
    }
    async function loadDirectory(currentUser: User | null) {
      setUser(currentUser);
      if (!currentUser?.access_token) { setAccessContext(undefined); return; }
      const response = await fetch("http://localhost:3000/api/directory/v1/me/access-context", { headers: { Authorization: `Bearer ${currentUser.access_token}` } });
      if (!response.ok) throw new Error(`Directory access failed (${response.status})`);
      setAccessContext(await response.json() as AccessContext);
    }
    async function initialize() {
      try {
        if (window.location.pathname === "/logout-complete") {
          const returnTo = new URLSearchParams(window.location.search).get("returnTo");
          globalLogoutChannel.postMessage("logout");
          await clearLocalAuthentication();
          window.location.replace(returnTo === "app-b" ? "http://localhost:4000/" : "/");
          return;
        }
        if (window.location.pathname === "/callback") { await auth.signinRedirectCallback(); window.history.replaceState({}, document.title, "/"); }
        await loadDirectory(await auth.getUser());
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Authentication failed"); } finally { setLoading(false); }
    }
    const handleGlobalLogout = () => { void clearLocalAuthentication().finally(() => { setUser(null); setAccessContext(undefined); }); };
    globalLogoutChannel.addEventListener("message", handleGlobalLogout);
    void initialize();
    const removeLoaded = auth.events.addUserLoaded((loadedUser) => { void loadDirectory(loadedUser).catch((caught) => setError(caught instanceof Error ? caught.message : "Directory access failed")); });
    const removeUnloaded = auth.events.addUserUnloaded(() => { setUser(null); setAccessContext(undefined); });
    const removeExpired = auth.events.addAccessTokenExpired(() => setUser(null));
    return () => { removeLoaded(); removeUnloaded(); removeExpired(); globalLogoutChannel.removeEventListener("message", handleGlobalLogout); };
  }, []);

  const signedIn = Boolean(user && !user.expired);
  async function signOutEverywhere() {
    globalLogoutChannel.postMessage("logout");
    try { await auth.revokeTokens(["access_token", "refresh_token"]); } catch { /* Continue through the logout chain. */ }
    await auth.removeUser();
    window.location.assign("http://localhost:3000/logout-all/app-a");
  }

  return (
    <main className="app-shell">
      <header className="page-header"><div className="app-mark">A</div><div><span className="eyebrow">SMZ identity architecture</span><h1>One sign-in, two safely different clients</h1><p>Follow the live OAuth 2.1 / OIDC relationships. Select any box for its responsibility.</p></div></header>
      <section className="flow-card" aria-label="OAuth and client application architecture">
        <div className="flow-canvas"><ReactFlow nodes={nodes} edges={initialEdges} nodeTypes={nodeTypes} onNodeClick={(_, node) => setSelectedNodeId(node.id)} nodesDraggable={false} nodesConnectable={false} elementsSelectable fitView fitViewOptions={{ padding: 0.16, minZoom: 0.45, maxZoom: 0.9 }} proOptions={{ hideAttribution: true }}><Background gap={20} size={1} color="#dce3eb" /><Controls showInteractive={false} /></ReactFlow></div>
        <aside className="node-explainer" aria-live="polite"><span className="eyebrow">Selected responsibility</span><h2>{selectedNode.data.title}</h2><p>{selectedNode.data.explanation}</p><div className="legend"><span><i className="public-dot" /> Public browser client</span><span><i className="confidential-dot" /> Confidential server client</span><span><i className="data-dot" /> Live directory query</span></div></aside>
      </section>
      <section className="security-note"><div><span className="eyebrow">The important boundary</span><strong>Identity is shared; authorization stays with each app.</strong></div><p>Tokens establish a stable person and live school context. App A and App B still decide their own action-level permissions and retain their own domain data.</p></section>
      <section className={`status ${signedIn ? "authenticated" : "anonymous"}`}><div className="status-dot" /><div><span className="eyebrow">Vite App A session</span><strong>{loading ? "Checking session…" : signedIn ? "Authenticated" : "Not authenticated"}</strong></div>{signedIn && user && <small>{String(user.profile.email ?? user.profile.sub)}</small>}</section>
      {error && <p className="error">{error}</p>}
      {signedIn && user && <section className="session-details"><span>Client <code>vite-app</code></span><span>Flow <code>Authorization Code + PKCE S256</code></span><span>Directory <code>{accessContext?.access ?? "checking"}</code></span><span>Roles <code>{accessContext?.roles.join(", ") || "none"}</code></span></section>}
      <div className="actions">{signedIn ? <button className="secondary" onClick={() => void signOutEverywhere()}>Sign out everywhere</button> : <button onClick={() => void auth.signinRedirect({ nonce: crypto.randomUUID() })}>Sign in through SMZ Auth</button>}<a href="http://localhost:4000">Open Express App B <span>↗</span></a></div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
