const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_HYPERDRIVE_ID: id } = process.env;
if (!account || !token || !id) throw new Error("Missing Cloudflare credentials or Hyperdrive ID");
const ids = process.env.DEPLOY_DEMO_APPS === "true" ? [id, process.env.APP_B_HYPERDRIVE_ID] : [id];
if (ids.some(value => !value)) throw new Error("Missing Hyperdrive binding");
for (const bindingId of new Set(ids)) {
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs/${bindingId}`, { headers: { Authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`Hyperdrive verification failed (${response.status})`);
const body = await response.json();
if (!body.success || body.result?.caching?.disabled !== true) throw new Error("Hyperdrive caching must be disabled before deploying identity services");
console.log("Verified Hyperdrive query caching is disabled.");

}
