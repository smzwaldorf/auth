# User administration

Visitors without a live session are redirected from `/admin` and its subpages to `/admin/sign-in`. The login page has no navigation and offers one **Sign in** button leading to the shared `/sign-in?admin=1` service. It starts a signed OAuth login request for the internal `smz-admin` client with a fixed `/admin` callback. The panel uses only the live central session and admin role; it does not exchange the returned authorization code or keep application tokens. Successful sign-in returns to `/admin`. The access-denied page also hides navigation.

Signed-in users without active administrator access are redirected from admin pages to `/admin`. That page returns 403 with “Not authenticated” and a Sign out button. Sign out uses a same-origin POST, clears the central session and cookie, then returns to administrator sign-in. Non-admin form submissions cannot perform admin writes.

Open `/admin` on the Auth service (locally, `http://localhost:3000/admin`), or follow **Manage users** from the application launcher. Use **Sign in** to choose a method on the shared login service with an existing approved administrator, or sign in through another application first and then return to `/admin`. Existing magic-link and gated local development application sign-in flows also establish the central session used by this panel. The first administrator must be provisioned through the reviewed directory seed; the panel never bootstraps administrator privileges.

The panel supports searching and filtering the directory, 25 records per page, creating adult login accounts, and editing adult names, school roles, lifecycle status, login approval, and application admission. New accounts are pre-approved with pending invitations but unverified email; the normal provider flow must verify email ownership. No email is sent by this panel. Saving **Approved** creates ongoing approval without an expiration. Existing staging email restrictions still apply.

Login email and person kind cannot be reassigned. Student records and reserved development identities are read-only. Family/class assignments can be managed in the Families, Students, and Classes screens. New application registration is available in Applications. Each CMS client follows the same automatic admission policy. Reapplying a seed that includes an edited person can overwrite that person's admin changes; reconcile the seed before reapplying it.

Every request requires a signed Better Auth session, a live database session, current login eligibility, and the live directory `admin` role. This role explicitly authorizes administration of the central directory; application roles continue to follow each application's own policy. Form submissions require the exact Auth origin and have a 16 KB body limit. Pages are private/no-store, escaped, and protected from framing with a restrictive content security policy.

Saves atomically update the directory, auth display name, roles, approval, admission and audit record. Admin writes are serialized and recheck the acting session/role inside the transaction. Version checks reject stale forms. An administrator cannot disable themselves, revoke their own approval, or remove their own admin role. Saving another existing user revokes all of that user's central sessions and OAuth access/refresh records; linked apps deny subsequent live authorization checks. Provider links remain intact. There is no hard-delete action.

## Validation

Run `npm test` and `npm run build`. Database-backed tests are in `packages/auth-server/tests/integration/admin.test.ts`; they require `RUN_DB_TESTS=true` and an explicitly supplied local `DATABASE_URL` whose database name matches `smz_magic_test_<digits>`. Create a disposable database and apply existing migrations first. Never point these tests at a real identity database.

## Automatic application access

All approved, active adult login accounts can access every enabled application automatically, including newly registered applications. No per-user application grants are required. Legacy `app_access` rows remain stored but no longer control admission, including rows marked revoked. Disable an account or revoke its login approval to block access globally. Application-specific roles and actions belong to the consuming application.

The Applications page lists registered clients, site URLs, client types and availability. Site URLs still describe registrations, but do not define per-user access lists. Existing site-access bookmarks redirect to the application list; stale grant/revoke submissions are rejected. OAuth client disabled flags and application enabled flags both remain enforced. Students, expired approvals, staging restrictions, and development identity safeguards remain enforced.

## Add an application

Open **Applications → Add application** (`/admin/applications/new`). Enter the name, site origin, exact callback URL, and after-sign-out URL. Choose a public browser client or confidential server client. HTTPS is required except for localhost development. Callback and sign-out URLs must belong to the site. Register production and development separately.

Creation atomically registers a PKCE S256 client and directory resource permission, with a generated client ID. Server secrets are cryptographically generated, stored only as SHA-256 hashes, and shown once in the uncached creation response. Store that secret on the application server. The setup page can be reopened from the site's registered login clients; it never retrieves secrets. Lost secrets currently require a replacement registration.

The setup page provides OIDC settings, the required directory resource audience, discovery location, and integration steps. Implement the callback using an OIDC library and check the directory access-context endpoint. The application remains responsible for local sessions and action authorization. Registration immediately makes the enabled client available to all approved, active users without creating per-user grants.

Enabled registrations are read dynamically for trusted browser origins and the application launcher; no per-app environment variable or restart is needed. This does not enable public dynamic client registration. The existing seed tools remain available for deployment-owned registrations. Admin-created clients use generated IDs to avoid overwriting seeded clients. Front-channel local logout cleanup is still configured through the seed metadata; applications without it must detect revoked central sessions themselves.

## Families, students and classes

1. Create a family under **Families** with a unique, stable family code.
2. Create or locate approved adult accounts under **Users**, then open the family and add each parent as father, mother, or guardian.
3. Create children under **Students**. Student records never create auth accounts or login invitations. Add each student to the family with relationship **child**.
4. Create a class under **Classes**, using the same class code as CMS. Open the class and add student enrollments. Adults with the teacher role can be assigned as teachers.
5. Use membership start/end dates for scheduled changes. Dates are inclusive; blank dates are unbounded. Set membership status to Inactive for immediate removal from the next live access-context check. Disable families, students or classes to exclude them without deleting history.

Group codes cannot be changed through this UI because applications use them for mapping. Family/class memberships reject overlapping active periods for the same person and group. Membership person/group/relationship is fixed: end a membership and add a new one to change those relationships. All writes recheck live admin authorization, use a directory snapshot version to reject stale forms, and record before/after audit details. Directory changes do not create application grants or change user approval.

The directory access context derives parent class scopes from active family memberships, active children and active student class memberships. CMS maps class codes to its local class IDs. Existing seed imports can overwrite managed records; reconcile them before reapplying seeds.
