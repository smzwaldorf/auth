# Magic-link login

Auth supports Google and passwordless email login. Sender: **Aida <info@useaida.app>** via Resend. Password sign-in, signup and password-management routes are rejected. Public signup is disabled.

Start from a registered application. The sign-in page offers an email form alongside Google. Auth validates the signed OAuth continuation and directory admission, sends a five-minute link, and resumes authorization after redemption. Tokens are hashed in the existing verification table and consumed atomically by Better Auth 1.7.2. No database migration is needed. Invitation activation follows successful magic-link session creation.

Unknown or unapproved addresses receive the same confirmation without an email or new user. The existing active-adult/exact-email/invitation checks run at delivery and session creation, and now also apply to Google repeat sessions and live token/directory admission. Students cannot receive magic links.

Delivery is awaited, times out after ten seconds, and reports failure without logging provider response bodies or links. Resends are limited to one per address per minute in PostgreSQL. Cloudflare's trusted connecting IP is additionally limited to ten requests and thirty verifications per minute across Worker instances. Node deployments outside Cloudflare need an equivalent trusted ingress IP limiter; arbitrary forwarded headers are not used. Expired throttle rows use Better Auth's verification cleanup.

## Enable on the existing staging deployment

The current Cloudflare deployment is **staging**. Actions use the GitHub `staging` environment. `NODE_ENV=production` continues enforcing hosted security settings. Do not change issuer URLs, Google callbacks, client IDs or existing secrets.

1. Verify **useaida.app** in Resend and confirm it can send from `info@useaida.app`. Disable open/click tracking for authentication mail. The prior smzwaldorf.com setup is superseded for this feature; do not delete it automatically.
2. Securely provision a sending-only `RESEND_API_KEY` in the GitHub `staging` environment, scoped to useaida.app where supported.
3. The confirmed emails are admin `smzwaldorf.education@gmail.com` and parent `buildwithharry@gmail.com`. Check their email-to-person mappings against the read-only CI account inventory. Configure `STAGING_ADMIN_EMAIL` and `STAGING_PARENT_EMAIL` as two distinct addresses. The code only checks existing roles: admin requires admin; parent requires parent and must not have admin. The login code never assigns roles or changes school records. The one-time `apply-staging-identities.ts` migration creates the two confirmed missing accounts with their selected roles, pending invitations, and App A/B grants. It rejects inventory conflicts, records an audit marker, and never restores revoked access or creates CMS grants. The September 13 read-only Actions inventory confirmed neither email existed.
4. Set `MAGIC_LINK_ENABLED=true`. CI forwards this flag, mappings, approved sender and the Resend key. Hosted configuration fails closed if mappings or key are missing. The default remains false, so adding the code does not silently activate delivery.
5. Release only by commit -> push main -> Actions validation -> Cloudflare deployment. A read-only Actions gate checks the two selected accounts before deployment.
6. With explicit authorization, test a real delivered email for each selected identity through App A and App B; test Google coexistence, refresh and logout. Real delivery/domain verification is not established by the local capture adapter.

When the staging mappings are configured, both Google and magic-link login and live directory/token access are restricted to them. Existing excluded session records can remain stored, but cannot mint directory tokens or use protected directory access; purge those sessions and grants only through a separately reviewed scoped account migration. Generic session introspection may still return a stored session; applications must retain live directory admission checks.

Use the same browser that initiated login so client state/PKCE remains available. If an email opens in another browser, begin a fresh application login there. Mail scanners may consume single-use links; requesting a fresh link is currently the recovery path.

## Verification

Integration tests capture email in memory without sending: both clients' actual code exchanges, hashed storage, five-minute expiry enforcement, sequential/concurrent reuse across Auth instances, revoked invitation, unknown/unselected identities, forged continuation, password endpoint rejection, sender errors and form submission. Unit tests cover Resend payload/failure and staging configuration. Run on a disposable database only. Browser form submission was checked with a local capture mailer; full staging mailbox/browser testing still requires the setup above.

## Approved CMS access

On September 13 the user additionally approved CMS access for both staging identities. `apply-staging-cms-access.ts` grants the shared `email-cms` admission once and verifies both public and confidential CMS clients. Admin and parent roles remain unchanged. A recorded migration never restores later revoked access. Request a fresh link from the CMS login page; previously expired links remain invalid.
