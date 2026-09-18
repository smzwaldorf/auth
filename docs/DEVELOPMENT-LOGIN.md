# Local Admin and Parent login

The signed application login chooser supports these synthetic identities:

| Button | Email | Exact role |
| --- | --- | --- |
| Continue as Admin | dev.admin@smz.example.test | admin |
| Continue as Parent | dev.parent@smz.example.test | parent |
| Continue as School Development Admin | admin@smzwaldorf.com | admin |
| Continue as School Development Teacher | teacher@smzwaldorf.com | teacher |

There is no password, email delivery, or Google account link for these identities. Google login remains available for other approved identities.

The feature defaults off. Set all of the following in the local process environment before starting Auth:

```dotenv
NODE_ENV=development
AUTH_ISSUER=http://localhost:3000/api/auth
CMS_ORIGIN=http://localhost:5173
ENABLE_DEV_LOGIN=true
DEV_LOGIN_DATABASE_NAME=smz_identity_dev
```

Also set `DATABASE_URL` to the separate loopback PostgreSQL database `smz_identity_dev`, using your local credentials. Do not use the original identity database or a hosted database. Apply existing migrations, register the local CMS client with `npx tsx packages/auth-server/src/seed/deploy-apps.ts` (leave `DEPLOY_DEMO_APPS=false`), then run `npm run development:seed -w @smz/auth-server`. The seeder verifies existing synthetic records and refuses collisions, changed roles or revoked grants; it does not overwrite existing people.

Start with `npm run dev:auth`. Open CMS at `http://localhost:5173` and start its normal sign-in flow. The chooser will show full-width Admin and Parent buttons. Use normal logout before switching accounts. Visiting `/sign-in` without an application request returns to the launcher.

The local endpoint accepts only the fixed identity choice and signed, expiring OAuth query. It requires actual loopback socket evidence, exact Host and Origin, and no forwarding headers. Each signed query is consumed once in PostgreSQL. Sessions use the normal Better Auth adapter and cookies; PKCE and directory access checks still apply. Switching identities removes the presented central session. Synthetic identity approval, exact role, provider-link absence and the development gate are rechecked during session creation, token issuance and directory access.

`NODE_ENV=test`, production and the Workers adapter cannot enable the feature. Neither the deployed staging configuration nor its database is changed by local setup. Never commit credentials or use this endpoint as a staging authentication bypass.

## School development accounts

The development seed also provisions `admin@smzwaldorf.com` (admin) and `teacher@smzwaldorf.com` (teacher), with reserved IDs and no provider links. The local chooser displays both addresses. Existing synthetic Admin/Parent accounts remain available. These accounts are development-only impersonations; no email is sent or mailbox ownership assumed. Existing conflicting identities cause the whole seed transaction to abort.

Run `npm run development:seed -w @smz/auth-server` with `NODE_ENV=development`, `ENABLE_DEV_LOGIN=true`, and `DEV_LOGIN_DATABASE_NAME` matching the explicitly selected local `_dev` or `_test` database. Register the local CMS client first. The server must use the same settings. The regular `smz_identity` database intentionally does not enable this bypass. Automatic application admission requires no app_access seed rows. When the local newsletter demo fixture is present, the seeder also assigns `teacher@smzwaldorf.com` as teacher of **Demo Grade 1A** (`DEMO-1A`) so teacher flows have data; this is insert-only and is not recreated if an administrator has ended it. Development identities' memberships show as **Seeded** in the admin panel and cannot be changed there.

## Development school environment

`npm run development:school -w @smz/auth-server` uses `DEV_PARENT_EMAIL` for the confirmed parent login and requires the same development-only database gates as quick login. Register CMS and migrate the database first. The local environment uses `smz_school_dev`.

When running CMS alongside App A and App B, set `CMS_ORIGIN=http://localhost:5173`, `APP_A_ORIGIN=http://localhost:5174`, and `APP_B_ORIGIN=http://localhost:4000` in the root `.env`. App A reads `APP_A_ORIGIN` for its development port and refuses to silently select another port. Restart Auth and App B after changing origins.

Every new development database needs the demo clients registered as well as CMS. Run `DEPLOY_DEMO_APPS=true DEPLOY_PAGES=true npx tsx packages/auth-server/src/seed/deploy-apps.ts` against the local database before starting the school seed. Despite the script's name, this command only updates database registrations; it does not deploy anything. Then start the clients with `npm run dev:app-a` and `npm run dev:app-b`.

The fixture is Development Grade 1 (`DEV-G1`), taught by `teacher@smzwaldorf.com`, with Demo Student One and Demo Student Two. Their historical links to Harry's Demo Family (`DEV-HARRY`) are seeded inactive. Harry is the guardian of Alton (辛丑乙, `smz110b`, enrolled 2020-11-01) and Caton (甲辰, `smz113`, enrolled 2024-09-01). Harry's parent class scopes are `smz110b` and `smz113`. The parent is an ordinary pre-approved adult and must verify email ownership through normal sign-in. This local seed reflects the setup confirmed on 2026-09-14. The administrator shortcut is `admin@smzwaldorf.com`. Existing records are preserved on rerun; identity conflicts abort the school transaction.

CMS can request `GET /api/directory/v1/me/directory` with its directory-scoped access token. The response preserves access-context fields and adds `directory.people`, `families`, `classes`, `familyMemberships`, and `classMemberships`. Person records contain IDs, names and kinds, without email addresses. Admins see the active directory; teachers see assigned classes and relevant family contacts; parents see their own family, children and class teachers. Inactive and out-of-date relationships are excluded. All requests use the existing live session, approval, client and bearer validation. CMS must use this endpoint to render names/links; existing class authorization still maps `DEV-G1` to local `classes.class_code`.
