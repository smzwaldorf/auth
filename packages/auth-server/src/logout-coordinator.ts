export type LogoutRegistration = {
  clientId: string;
  displayName: string;
  publicOrigin: string | null;
  postLogoutRedirectUris: string[] | null;
  metadata: unknown;
};
export type LogoutTarget = { clientId: string; displayName: string; origin: string; logoutUri: string };

export function parseLogoutReturn(value: string | undefined): string | undefined {
  if (value === "app-a") return "vite-app";
  if (value === "app-b") return "express-app";
  return value && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : undefined;
}
function registeredUrl(value: unknown, origin: string | null): URL | undefined {
  if (typeof value !== "string" || !origin) return;
  try {
    const url = new URL(value), registered = new URL(origin);
    if (registered.origin !== origin || url.origin !== origin || url.username || url.password || url.hash) return;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return;
    return url;
  } catch { return; }
}
export function logoutPlan(registrations: LogoutRegistration[], returnClient: string) {
  const returning = registrations.find((entry) => entry.clientId === returnClient);
  const returnUrl = returning?.postLogoutRedirectUris?.map((uri) => registeredUrl(uri, returning.publicOrigin)).find(Boolean)?.href;
  if (!returnUrl) return undefined;
  const targets: LogoutTarget[] = [];
  const unavailable: string[] = [];
  for (const entry of registrations) {
    const metadata = entry.metadata as { frontChannelLogoutUri?: unknown } | null;
    const url = registeredUrl(metadata?.frontChannelLogoutUri, entry.publicOrigin);
    if (!url || url.search) { unavailable.push(entry.displayName); continue; }
    targets.push({ clientId: entry.clientId, displayName: entry.displayName, origin: url.origin, logoutUri: url.href });
  }
  return { returnUrl, targets, unavailable };
}
function json(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c"); }
export function renderLogoutPage(plan: NonNullable<ReturnType<typeof logoutPlan>>, state: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing out · SMZ Identity</title><style>body{font:16px system-ui;background:#f2eee8;color:#28211d;margin:0;padding:24px}main{max-width:620px;margin:8vh auto;background:white;border-radius:20px;padding:32px}li{margin:10px 0}a{display:inline-block;margin-top:16px;color:#8b3e25}iframe{display:none}</style></head><body><main><h1>Signing out of linked applications</h1><p>Your central session and its application credentials have been revoked.</p><ul id="results"></ul><p id="status" role="status">Clearing local application sessions…</p><a id="continue" hidden>Continue</a><noscript>JavaScript is needed to clear each application's local browser state. Your central access is revoked; revisit each app to clear its session.</noscript></main><script>
const plan=${json(plan)},state=${json(state)},pending=new Map(),list=document.getElementById('results');
let finished=false;
function row(name,status){const li=document.createElement('li');li.textContent=name+': '+status;list.appendChild(li);return li;}
const failures=plan.unavailable.map(name=>{row(name,'local cleanup is not registered');return name;});
function finish(){if(finished||pending.size)return;finished=true;const status=document.getElementById('status');const link=document.getElementById('continue');link.href=plan.returnUrl;link.hidden=false;status.textContent=failures.length?'Central sign-out complete. Local cleanup could not be confirmed for '+failures.join(', ')+'. Those apps must check their session when reopened.':'Signed out of all linked applications.';if(!failures.length)window.location.replace(plan.returnUrl);}
window.addEventListener('message',event=>{const item=pending.get(event.source);if(!item||event.origin!==item.target.origin||event.data?.type!=='smz:logout-complete'||event.data?.state!==state)return;clearTimeout(item.timer);item.row.textContent=item.target.displayName+': signed out';pending.delete(event.source);item.frame.remove();finish();});
for(const target of plan.targets){const frame=document.createElement('iframe');frame.title='Sign out '+target.displayName;const uri=new URL(target.logoutUri);uri.searchParams.set('logout_state',state);const line=row(target.displayName,'clearing local session');document.body.appendChild(frame);const source=frame.contentWindow;const timer=setTimeout(()=>{if(!pending.has(source))return;pending.delete(source);failures.push(target.displayName);line.textContent=target.displayName+': local cleanup not confirmed (unreachable or blocked)';frame.remove();finish();},3500);pending.set(source,{target,frame,row:line,timer});frame.src=uri.href;}
finish();
</script></body></html>`;
}
