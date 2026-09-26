# Production Auth deployment

Manual workflow: **Deploy production Auth**, from `main` only. It deploys `production-smz-auth` at `https://auth.smzwaldorf.com`; demo apps are neither registered nor deployed. Main pushes continue to use the existing staging workflow.

Use the existing SMZ Cloudflare account and PlanetScale `smzwaldorf/main` cluster. Provision an empty logical database `production-auth` and a dedicated, uncached Hyperdrive connector `production-smz-auth`. Restrict its database role to that database. Do not reuse the staging database or bootstrap test identities.

The historical GitHub environment `production` contains staging credentials. This workflow therefore uses prefixed production credentials in that same secret store:

- Variable `PRODUCTION_AUTH_HYPERDRIVE_ID`
- Secret `PRODUCTION_DATABASE_URL`: direct PlanetScale connection to `/production-auth`
- Secrets `PRODUCTION_BETTER_AUTH_SECRET`, `PRODUCTION_UNUSED_APP_B_SECRET`: independent random values of at least 32 characters
- Secret `PRODUCTION_CMS_OIDC_CLIENT_SECRET`: independent value shared only with production News

Existing Cloudflare credentials and Google OAuth client credentials are reused. Add `https://auth.smzwaldorf.com/api/auth/callback/google` to the existing Google client before browser verification; retain staging callbacks.

The workflow applies schema migrations and registers only the two News clients. It does not create people or grant access. The approved administrator must be provisioned separately before login verification. Magic-link login is disabled for this initial Google-only deployment because the current runtime's magic-link setup requires staging identities and uses an unrelated sender.

Deploy Auth before News. Verify discovery, Google callback, administrator access, and News login/logout. Resource deployment alone is not completion.
