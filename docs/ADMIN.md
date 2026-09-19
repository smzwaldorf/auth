# User administration

Visitors without a live session are redirected from `/admin` and its subpages to `/admin/sign-in`. The login page has no navigation and offers one **Sign in** button leading to the shared `/sign-in?admin=1` service. It starts a signed OAuth login request for the internal `smz-admin` client with a fixed `/admin` callback. The panel uses only the live central session and admin role; it does not exchange the returned authorization code or keep application tokens. Successful sign-in returns to `/admin`. The access-denied page also hides navigation.

Signed-in users without active administrator access are redirected from admin pages to `/admin`. That page returns 403 with “Not authenticated” and a Sign out button. Sign out uses a same-origin POST, clears the central session and cookie, then returns to administrator sign-in. Non-admin form submissions cannot perform admin writes.

Open `/admin` on the Auth service (locally, `http://localhost:3000/admin`), or follow **Manage users** from the application launcher. Use **Sign in** to choose a method on the shared login service with an existing approved administrator, or sign in through another application first and then return to `/admin`. Existing magic-link and gated local development application sign-in flows also establish the central session used by this panel. The first administrator must be provisioned through the reviewed directory seed; the panel never bootstraps administrator privileges.

## Language

The panel renders in **Traditional Chinese (zh-Hant) by default** and can be switched to **English** with the 繁體中文 / English toggle in the sidebar (also shown on the sign-in and access-denied pages). The choice is stored per browser in the `smz_admin_lang` cookie (`Path=/admin`, HttpOnly, one year) via `POST /admin/lang`, which only accepts `zh-Hant` or `en` and `/admin` return paths. Every string is localized — pages, form labels, relationship graphs, and the server-side validation and save errors — through `src/admin/i18n.ts`, keyed by the English source text with translations in `src/admin/i18n.zh-hant.ts`. A missing translation falls back to English rather than rendering blank, and a unit test fails the build when a `t("…")` key has no Traditional Chinese entry. Person, family and class names are shown as stored and are never translated.

## Layout

The panel is server-rendered with no client-side scripts (the content security policy allows inline styles only). A sidebar groups the sections:

- **Overview** (`/admin`): counts, quick actions, and a **Needs attention** list of relationship gaps — students without a class or family, families without an active parent or guardian or without children, classes without a teacher, and parents not linked to any family. Each item links to the matching filtered list.
- **Users** (`/admin/users`): every person, 25 per page, searchable by name or email and filterable by kind (adult/student), role and status. Each row shows the person's effective family and class memberships as links.
- **Students**, **Families**, **Classes** (`/admin/students`, `/admin/families`, `/admin/classes`): directory lists with search, status and gap filters (for example `?needs=class`), and dedicated detail pages at `/admin/<section>/<id>`. `?id=<uuid>` links from the previous layout redirect to the new pages.
- **Applications** (`/admin/applications`): registered OIDC clients and their setup pages.

Detail pages re-render with the submitted values and an error notice when a save is rejected, and redirect back to the page the form was submitted from (`returnTo`, restricted to `/admin` paths) on success.

## Users

**Users → Add adult** (`/admin/users/new`) pre-approves an adult login account. New accounts have pending invitations but unverified email; the normal provider flow must verify email ownership. No email is sent by this panel. Account status is the only access control in the form. Saving an existing account restores its internal invitation with no expiry; Disabled still blocks all access. **Force sign out** on an existing adult account removes every central session and OAuth access/refresh token without changing the account status or invitation. Existing staging email restrictions still apply.

The adult page (`/admin/users/<id>`) also manages that adult's relationships from the person's side: current family memberships and class assignments with **End** and date controls, a **Children** list derived from active families, **Add to a family** (search families, then choose mother/father/guardian) and, for adults with the Teacher role, **Assign to a class**. Opening a student's id under `/admin/users` redirects to the student page.

Login email and person kind cannot be reassigned. Reserved development identities are read-only. New application registration is available in Applications. Each CMS client follows the same automatic admission policy. Reapplying a seed that includes an edited person can overwrite that person's admin changes; reconcile the seed before reapplying it.

Every request requires a signed Better Auth session, a live database session, current login eligibility, and the live directory `admin` role. This role explicitly authorizes administration of the central directory; application roles continue to follow each application's own policy. Form submissions require the exact Auth origin and have a 16 KB body limit. Pages are private/no-store, escaped, and protected from framing with a restrictive content security policy.

Saves atomically update the directory, auth display name, roles, approval, admission and audit record. Admin writes are serialized and recheck the acting session/role inside the transaction. Version checks reject stale forms. An administrator cannot disable themselves or remove their own admin role. Saving another existing user revokes all of that user's central sessions and OAuth access/refresh records; linked apps deny subsequent live authorization checks. Provider links remain intact. There is no hard-delete action.

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

Relationships can be managed from either side: open a family or class to manage its members, or open a person to manage their memberships. Every detail page opens with a **Relationship graph**: the record in focus in the centre, its direct relations on the tiers above and below (for example parents above a family, children below), and second-degree relations on the outer tiers (the children's classes, a class roster's families, a student's guardians via their families). Nodes link to the related record; scheduled or disabled connections are dimmed. The graph is plain HTML and CSS — no scripts are used anywhere in the panel. Every membership row shows its state — **Active**, **Scheduled** (starts in the future), **Ended** (end date passed) or **Inactive** — with **End** and **Dates** controls. Ended and inactive memberships stay visible under **Membership history** on the group page, where inactive rows can be **Restored**.

**Family page** (`/admin/families/<id>`): parents and guardians, children, and an **Add members** panel. Search by name or email; matching adults get a mother/father/guardian choice, matching students an **Add as child** button, and people already in the family are excluded. **Create a new child in this family** creates the student record and the child membership in one transaction. **Add adult account** opens the user form and, after the account is created, returns to the family with the new adult pre-searched so they can be added immediately.

**Class page** (`/admin/classes/<id>`): teachers and students. The Teachers card has an **Assign teachers** checklist of every adult with the Teacher role not yet assigned (opened automatically when the class has no teacher), with optional start/end dates; a class can have several teachers. If nobody is available it links to Users to grant the Teacher role, or to create a new teacher account that returns to the class. Student search results are a checklist so several students (and teachers) can be added together; relationships are inferred from the person's kind. Without a search term the panel lists students not yet in any class. Selected enrolled students can be **ended** or **moved** to another class in one step: moving ends the enrollment here and starts a new one in the destination, preserving history. **Create a new student in this class** creates and enrolls in one transaction.

**Student page** (`/admin/students/<id>`): name and status, families (add via family search), class enrollments (add via class select) and the derived **Parents & guardians** and **Siblings** lists.

Recommended order when not using the wizard:

1. Create a family under **Families → Add family** with a unique, stable family code.
2. Create or locate approved adult accounts under **Users**, then add each parent to the family as father, mother, or guardian.
3. Create children from the family page (**Create a new child**), from **Students → Add student** (optionally linking to a family or class on creation), or from the class page. Student records never create auth accounts or login invitations.
4. Create a class under **Classes → Add class**, using the same class code as CMS. Enroll students from the class page and assign a teacher.
5. Use membership start/end dates for scheduled changes. Dates are inclusive; blank dates are unbounded. **End** a membership for immediate removal from the next live access-context check. Disable families, students or classes to exclude them without deleting history.

Group codes cannot be changed through this UI because applications use them for mapping. Family/class memberships reject overlapping active periods for the same person and group; a bulk add that includes one conflicting person rolls back the whole batch. Membership person/group/relationship is fixed: end a membership and add a new one (or use **Move** for classes) to change those relationships. All writes recheck live admin authorization, use a directory snapshot version to reject stale forms, and record before/after audit details. Directory changes do not create application grants or change user approval.

The directory access context derives parent class scopes from active family memberships, active children and active student class memberships. CMS maps class codes to its local class IDs. Existing seed imports can overwrite managed records; reconcile them before reapplying seeds.

## Quick family setup

Open **Families → New family setup** (`/admin/families/wizard`). Add a student, choose an active class, then choose an existing family or create one with a name suggested from the student. Existing families skip the adult step and reuse their current members. For a new family, add existing adults or enter names and emails for new parents and guardians. Review the family graph and confirm creation. Existing family members remain connected. Confirmation lands on the new family's page.

Nothing is saved before confirmation. Confirmation atomically creates the student, enrollment, family (when new), adult accounts and relationships. New adults receive the Parent role and an unverified email account; no email is sent. Existing adults retain their other roles. Signed drafts expire after one hour and are bound to the administrator; final submission rechecks live access and selected records. Repeated confirmation does not create duplicates.
