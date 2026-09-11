# Cloudflare deployment

## Current provisioning scope

Cluster `smzwaldorf/smzwaldorf` contains the logical databases `smz-auth` (Auth and the App B demo session schema) and `smz-cms` (empty, reserved for CMS). They share one PlanetScale Postgres 17, Tokyo, PS-5 single node at $5/month base, 10 GB storage cap, billed through Cloudflare account 善美真. Both Workers use the same Hyperdrive configuration with query caching disabled. App B sessions live in `app_b.session`; Auth migrations retain their existing schemas. Sharing credentials means schema separation is not a database privilege boundary.

This supersedes the initial per-app cluster plan. `DEPLOY_DEMO_APPS=true` publishes both clients. CI registers their exact origins without importing people or granting directory access, migrates both schemas using the existing `PLANETSCALE_DATABASE_URL` secret, and creates the Pages project if needed. Set `APP_B_HYPERDRIVE_ID` equal to `CLOUDFLARE_HYPERDRIVE_ID`; no separate App B migration credential is required. App A is static and needs no database.

On 2026-09-11, the default `postgres` database could not be renamed because PlanetScale Patroni connections use it. Auth's `auth`, `directory`, and `drizzle` schemas were copied to `smz-auth`; all 23 tables passed content-checksum comparison. Hyperdrive and the GitHub production migration secret now target `smz-auth`, and the live Auth health check passed. The original schemas remain in `postgres` as a recovery copy, not the active application database. The temporary transfer role was revoked. The extra `smz-app-b` cluster was deleted.

## Runtime layout

| Component | Hosting | Entrypoint / build |
| --- | --- | --- |
| SMZ Identity, Google callback, OIDC, directory API | Worker `smz-auth` | `packages/auth-server/src/worker.ts` |
| App A | Cloudflare Pages | `npm run build:app-a`, output `apps/vite-app/dist` |
| App B confidential OIDC client | Worker `smz-app-b` | `apps/express-app/src/worker.ts` |
| Auth and directory | PlanetScale **Postgres** `smz-auth` through Hyperdrive | Auth Drizzle migrations |
| App B sessions | Shared PlanetScale **Postgres** `smz-auth`, `app_b` schema | `apps/express-app/migrations` |

App B's directory/package name remains `apps/express-app` / `@smz/express-app` and its registered client ID remains `express-app`. Its HTTP implementation is now Hono, shared by the Node and Worker entrypoints. Both Workers create their database pools inside each request and close them after processing. Transactions remain PostgreSQL transactions. No database objects or sockets are shared across Worker requests.

App B stores only an opaque, random session ID in a Secure, HttpOnly, SameSite=Lax `__Host-` cookie. IDs are hashed in the App B session table; session payloads containing OAuth tokens are AES-GCM encrypted using `APP_B_COOKIE_SECRET`. The one-hour session expiry is absolute. Login and callback rotate IDs; a PostgreSQL transaction/advisory lock serializes operations for each existing session across isolates. An hourly Worker schedule removes expired sessions. Rotating the cookie secret invalidates existing App B sessions.

## One-time infrastructure setup

1. Choose three HTTPS origins: identity, App A, and App B. Cloudflare-provided domains are supported: `smz-auth.<account-subdomain>.workers.dev` for Auth, `smz-app-b.<account-subdomain>.workers.dev` for App B, and `<pages-project>.pages.dev` for App A. The generator enables `workers_dev` and omits custom-domain routes for these Worker hostnames. Custom Worker domains must belong to a zone in the target account; optional Pages custom domains must be configured separately.
2. Create a PlanetScale **Postgres** database and production branch, then obtain its primary connection credentials. Do not use the PlanetScale MySQL/Vitess product or serverless MySQL driver. Create the Hyperdrive configuration using the PlanetScale connection details and **disable query caching**. Auth admission and revocation depend on fresh reads. The release workflow verifies `caching.disabled` through Cloudflare's API.
3. When enabling demo apps, give the CI token Pages Write on the deployment account. CI ensures a Cloudflare Pages **Direct Upload** project with production branch `main` exists. Do not enable a second Git integration deployment path: GitHub Actions publishes it from the validated commit.
4. Configure the GitHub `production` environment with the variables and secrets below. Restrict deployment to `main` with branch/environment protection appropriate to the repository.
5. Register the exact Google Web OAuth redirect `${AUTH_ISSUER}/callback/google`. Only `openid profile email` is requested. Existing users must have pre-approved, exact verified Google emails.
6. Prepare and review the production directory seed. Change every client public origin, callback and post-logout URL to match the hosted origins. The helper below creates a new ignored file without overwriting an existing one:

   ```sh
   APP_A_ORIGIN=https://app-a.your-domain.tld APP_B_ORIGIN=https://app-b.your-domain.tld \
     node scripts/prepare-seed.mjs packages/auth-server/seeds/directory.seed.private.json \
     packages/auth-server/seeds/production.private.json
   ```

   Use real approved directory data, not the committed example adults. Run migrations and the seed CLI against the direct PlanetScale connection with the production issuer, both application origins, and the same `APP_B_CLIENT_SECRET` used by App B. Set `NODE_ENV=production` and all auth secrets so configuration validation runs. Keep credentials in the environment or a local ignored file; never commit them. The seed CLI defaults to dry-run; explicitly supply `--apply` after reviewing its summary. Directory seeding is an operator bootstrap/update action and is not repeated automatically by deployments.

   ```sh
   npm run db:migrate
   npm run directory:seed -- --file packages/auth-server/seeds/production.private.json
   npm run directory:seed -- --file packages/auth-server/seeds/production.private.json --apply
   ```

   Changing the issuer changes the token audience and identity issuer. Existing sessions/tokens must be replaced by fresh logins, and consuming applications must use the new `(issuer, sub)` mapping deliberately.

### GitHub environment variables

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Target account ID |
| `CLOUDFLARE_HYPERDRIVE_ID` | Auth-only Hyperdrive configuration ID with caching disabled |
| `DEPLOY_DEMO_APPS` | `false` initially; only `true` publishes the demo apps |
| `APP_B_HYPERDRIVE_ID` | Same value as `CLOUDFLARE_HYPERDRIVE_ID` for the shared database |
| `AUTH_ISSUER` | `https://smz-auth.<account-subdomain>.workers.dev/api/auth` (or a custom domain), no trailing slash |
| `APP_A_ORIGIN` | App A HTTPS origin, no trailing slash |
| `APP_B_ORIGIN` | App B HTTPS origin, no trailing slash |
| `PAGES_PROJECT_NAME` | Existing Direct Upload Pages project |

### GitHub environment secrets

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts Edit, Pages Edit, Hyperdrive Read, and permissions for the target custom domains/zone only when using custom domains |
| `PLANETSCALE_DATABASE_URL` | Direct primary Postgres connection with TLS, used only by migrations |
| `BETTER_AUTH_SECRET` | Random secret, at least 32 characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Web OAuth credentials |
| `APP_B_CLIENT_SECRET` | Random secret, at least 32 characters; must match seeded client |
| `APP_B_COOKIE_SECRET` | Independent random secret, required only with demo deployment |

Use verified TLS for the direct database connection. Hyperdrive holds the runtime database credentials; neither Worker receives `PLANETSCALE_DATABASE_URL`, and the frontend receives no secrets. The Pages build gets only `VITE_AUTH_ISSUER` and `VITE_APP_B_ORIGIN`.

## Release path

`.github/workflows/ci.yml` validates pull requests and pushes to `main`. It runs type checks, unit tests, all builds, Worker dry-run bundles, migrations on a fresh PostgreSQL database, OIDC/directory tests, and durable-session tests.

Only a push to `main` deploys. After validation, it generates configs from GitHub environment variables, verifies Hyperdrive caching, prepares secrets, runs migrations through the direct PlanetScale connection, deploys Auth, then checks its health and OIDC discovery. If `DEPLOY_DEMO_APPS=true`, it also registers both OIDC clients, migrates App B's schema in the shared database, builds App A, ensures the Pages project exists, and deploys App B and Pages. No manual `workflow_dispatch` or `npm run deploy` path is provided. Infrastructure/bootstrap commands above do not publish application code.

The checked-in Wrangler files contain explicit placeholders for dry-run validation. `npm run cloudflare:configure` rejects missing or placeholder production configuration. Generated files live in ignored `.wrangler/`; CI passes secret files to Wrangler and deletes them even on failure. Keep Worker secrets stable across normal releases.

When demo apps are enabled, deployment is sequential, not atomic across three services. Use additive migrations and backwards-compatible protocol changes. If publication fails partway, inspect the GitHub run and correct/revert through another commit. Do not roll back PostgreSQL by deleting migration records or replaying old schema snapshots.

## Migration and operations notes

The unreleased App B session migration was moved out of Auth into `apps/express-app/migrations/0001_sessions.sql` before any production migrations were applied. Auth migrations create only identity/directory tables. Run `npm run db:migrate:app-b` with `APP_B_DATABASE_URL` pointing to the shared database when provisioning App B. Older branches of this repository rewrote migration history before this change: an existing database with a different Drizzle journal needs a schema/history reconciliation and backup before migration. Validate on a PlanetScale development branch first. A fresh database can apply this repository's complete migration chain.

Before exposing production, configure PlanetScale backups/recovery, separate staging resources, secret rotation ownership, and Worker monitoring. Test a real Google login in both clients, refresh, CORS from the exact Pages origin, and coordinated logout in both directions. Revoke a user's app access and confirm the next directory request fails. CI health/discovery checks and local runtime checks cannot replace those live Google/browser checks.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run cloudflare:check
```

For Node development, `npm run dev` still runs the three services. Auth uses `DATABASE_URL`; App B uses `APP_B_DATABASE_URL` or falls back to `DATABASE_URL` (local default `smz_identity`). Migrate both schemas when running all local demos. For isolated integration tests, set `DATABASE_URL` to a disposable database, run migrations, then:

```sh
npm run test:integration -w @smz/auth-server
RUN_DB_TESTS=true npx vitest run apps/express-app/tests --no-file-parallelism
```

Worker bindings use strict production configuration even under `wrangler dev`. To test locally in workerd, use an ignored config with HTTPS test origins, test-only secrets, and the Hyperdrive `localConnectionString` pointed at a disposable database. That checks runtime compatibility, not real Hyperdrive connectivity. The committed example URLs/secrets are deliberately rejected at runtime.

## References

- [Cloudflare: PlanetScale Postgres with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/)
- [Cloudflare: PostgreSQL drivers and request-scoped connections](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [Cloudflare: disabling query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [PlanetScale: Postgres and Cloudflare Workers](https://planetscale.com/docs/postgres/tutorials/planetscale-postgres-cloudflare-workers)

## Conversion validation (2026-09-11)

- Workspace type checks and all three application builds passed.
- 13 unit tests and 13 integration tests passed on a disposable PostgreSQL 17 database; all migrations applied successfully from an empty database.
- Both Worker bundles passed Wrangler dry-run compilation.
- Both Workers ran under local workerd with database health checks; Auth discovery/sign-in and five concurrent Auth database requests passed. App B's anonymous/protected/logout routes passed.
- App A and App B rendered in a browser. Pages uses its default SPA fallback (no top-level `404.html` or callback redirect rules), preserving the callback pathname and query while serving the SPA document. A callback without OAuth state was correctly rejected by the frontend.
- Workflow YAML and production-config generation were checked. No live Cloudflare/PlanetScale publication, real Hyperdrive connection, or complete Google sign-in/refresh/logout browser cycle was performed. Production identifiers, domains, credentials and bootstrap remain operator inputs.
