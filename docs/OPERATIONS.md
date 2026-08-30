# Production operations

This runbook covers the SMZ Identity service, its PostgreSQL data, and the
server-side session data used by confidential clients. It does not authorize a
production deployment; DNS changes, secret provisioning, data migration, and
cutover remain explicit operator actions.

## Deployment boundary

- Terminate TLS at a maintained reverse proxy and expose only HTTPS publicly.
- Keep PostgreSQL on a private network or loopback interface. Never publish port
  5432 to the internet.
- Run `@smz/auth-server` and each confidential client as separate unprivileged
  processes with restart policies and startup after reboot.
- Restrict the database role to the SMZ Identity database. Application
  processes must not use a PostgreSQL superuser.
- Store environment values in the deployment platform or a root-readable
  secret file outside the repository.

Production startup fails closed when the issuer is not HTTPS, development login
is enabled, or required database, OAuth, magic-link delivery, and client secrets
are absent or still use repository placeholders.

## Release procedure

1. Back up PostgreSQL and record the current application revision.
2. Build an immutable artifact with `npm ci` and `npm run build`.
3. Run `npm run typecheck`, `npm test`, and the PostgreSQL integration suite.
4. Apply migrations with `npm run db:migrate` before starting the new process.
5. Start the Auth service and confidential clients with production environment
   values. Do not place secret values in command history.
6. Verify `/health`, OIDC discovery, an approved Google login, an approved magic
   link, both PKCE clients, refresh, revocation, and global logout.
7. Monitor application errors, authentication denials, database health, disk
   space, certificate expiry, and mail-delivery failures through the observation
   window before retiring the previous artifact.

## PostgreSQL backup

Create encrypted, off-host backups on a schedule appropriate to the school's
recovery objectives. The backup must include the `auth`, `directory`, and
`application` schemas because they contain identities, signing keys, sessions,
OAuth grants, directory relationships, and audit records.

Use a non-interactive protected credential source and write the dump to a
restricted temporary location before encryption and transfer:

```bash
pg_dump --format=custom --no-owner --no-acl --file=smz-identity.dump "$DATABASE_URL"
pg_restore --list smz-identity.dump
```

Do not commit dumps, credentials, or restore logs containing personal data.
Retain multiple generations off the VPS and monitor backup completion and age.

## Restore test

Restore into an isolated empty database, never over the live database:

```bash
createdb smz_identity_restore_test
pg_restore --exit-on-error --no-owner --no-acl --dbname=smz_identity_restore_test smz-identity.dump
```

Point a non-production Auth instance at the restored database and verify health,
OIDC discovery, seeded-client registration, an approved sign-in, directory
access, refresh, revocation, and logout. Destroy the isolated restored copy using
the approved data-handling process after recording the test result.

## Rollback and incident response

- Stop new traffic before rolling back a migration or artifact.
- Prefer restoring the previous artifact while retaining a forward-compatible
  database. Restore a database backup only when the migration rollback has been
  reviewed and data written after the backup has been reconciled.
- Rotate affected OAuth, cookie, Better Auth, mailer, and database credentials
  after suspected disclosure. Revoking a person or app must also remove its
  sessions and OAuth grants.
- Preserve relevant audit events and sanitized service logs for investigation;
  never copy tokens, magic-link URLs, cookies, or personal data into a public
  issue.
