# Family and personal profiles in SMZ Auth

The implementation, database migrations, parent portal, review screens, and tests all live in this repository. Forms is not required.

## Native portal setup

1. Apply additive Drizzle migrations `0005_family_profile_approvals`, `0006_person_profile_approvals`, and `0007_family_form_revisions` with the normal Auth migration procedure.
2. Visit `/profiles` or a direct portal link on the Auth origin. This registers the native `smz-profiles` client, without granting profile capabilities. Sign-in follows the existing school OIDC flow; the portal uses the live central session and discards the authorization code.
3. In `/admin/family-profile-settings`, enable family and personal profile capabilities for **Family and personal profiles** (`smz-profiles`). Appoint registrars as needed. Existing admins can review. No capability is automatically enabled or re-enabled.
4. Use `/profiles/family` and `/profiles/person`. `/family` and `/profile` redirect to these pages.

The family page defaults to approved information only. **編輯資料** opens `?edit=1`: approved information stays in the first column and the unified form appears in the second column. On small screens the columns stack, with current information first. **取消編輯** returns to the display view without saving. The editor uses one form for household contact details and all adults, arranged vertically. Parents can add a new adult, edit names/contact details/relationships, remove an existing adult, or undo removal before sending. One **送出全部變更** button submits everything directly for independent review, with no draft step. Existing contact-only drafts are loaded into the unified form; a returned full-family request can be corrected and resubmitted directly. Children remain visible in the relationship graph.

The native POST `/profiles/family/:id/submit-all` requires both confidential-client profile capabilities, a live admitted session, exact Origin, current guardian membership, current household revision, and a roster fingerprint covering approved adult profiles and membership records. It freezes one schema-version-2 submission. Duplicate identical sends are idempotent. At least one adult must remain, unrelated existing person IDs are rejected, and pending personal requests must be resolved first.

Approval applies household details, personal profiles, new adult records, and membership changes in one transaction. A stale household, adult profile, or membership aborts the whole approval. Removing an adult marks their memberships inactive and retains the person, account, and history. A relationship change creates a fresh membership; new adults receive contact records only, with no login account, invitation, or role grant. Personal revisions reference the family request through migration `0007`; family submission/revision history includes the complete proposed adult changes. The submitter and affected adults cannot review their own request, and reviewers who share a family with an affected adult are excluded.

The page has a responsive layout with labels above full-width controls and a relationship graph connecting current adults to their children. Desktop and 390px mobile layouts were checked. The browser fixture includes synthetic parents and children and can preserve existing demo records.

Phone fields accept digits, hyphens and parentheses. New saves remove visual separators while preserving country codes and extensions; edit fields also show existing numbers without separators. Read-only profile, comparison, family-member and history views format recognised Taiwan mobile and landline numbers. Other numbering plans are left ungrouped rather than guessed. Punctuation-only changes do not create a new submission, and historical snapshots are not rewritten.

All reads and actions retain the existing live session, directory admission, application, confidential-client, capability, membership, and reviewer checks. Native form POSTs require the exact Auth Origin. The bearer APIs below remain available for explicitly enabled integrations.

Regular users see their own personal profile and current families, including other parents' approved contact details and children's names/relationships. Current adult parents and guardians can request changes for all other current parents and guardians in the same active family. A delegated applicant can see their own requests, submissions, and decisions; unrelated personal requests and revision history remain restricted to the subject and authorized reviewers. Admins and explicitly appointed registrars have independent review authority. Approval is atomic, self-approval is denied, and old submissions and revisions are retained.

## Local verification

```sh
npm run build:auth
npm run test:profiles
npm test
NODE_ENV=test node scripts/profile-browser-server.mjs
```

`test:profiles` reads the loopback connection from this repository's `.env`, creates `smz_family_profiles_test` if missing, and resets only that dedicated database's fixture tables. The browser fixture runs Auth alone on `127.0.0.1:3018`, using `smz_family_profiles_ui_test` and synthetic accounts; it resets that fixture unless `PROFILE_UI_REUSE=true`. Test-only sign-in shortcuts are printed at startup and never mounted in the production entry point.

Verification: 44 profile integration tests, 55 Auth unit tests, and 7 sample-app regression tests pass. Auth builds successfully. Tests cover single-post submission and retry, atomic adult/household approval, additions/removals, preserving removed people, self-removal with another adult retained, minimum-adult validation, unrelated IDs, stale rosters and personal revisions, return/resubmit, and rollback after a later revision write fails. Existing session, capability, privacy, approval, phone, and history regressions remain covered. A synthetic browser walkthrough verified adding/removing/undoing adults, one combined submission, and independent registrar approval updating the address, father’s phone, and a new guardian together.

No production database migration, deployment, or push has been performed.

## API and domain reference

### Family contact approvals

The directory owns household contact profiles, drafts, submitted versions, reviewer decisions, and approved revision history. The native Auth portal provides parent and reviewer screens at `/profiles/family`. Apply additive migration `0005_family_profile_approvals` before enabling clients.

Administrators use `/admin/family-profile-settings` to enable the `familyProfiles: true` metadata capability on trusted confidential clients and appoint/revoke school-wide registrar reviewers. This grants no broader admin access. OAuth `directory:access` alone is insufficient, and a role in an activity form grants no review authority. Every bearer API request validates the bearer token and its issuer, audience, scope, subject, authorized client, live central session, live admission, client capability, and applicable guardian/reviewer permission.

API root: `/api/directory/v1/family-profiles` (no trailing slash).

| Method/path | Behavior |
| --- | --- |
| GET root | Current guardian families, review capability, first 200 pending requests and profile families for reviewers |
| GET `/families/:id` | Approved profile, visible open request, filtered approved/submitted history and events |
| POST `/families/:id/requests` | Create one shared draft with caller-generated UUID `id`; same creation retry is safe |
| POST `/requests/:id/save` | `{version, baseRevision, data:{mailingAddress,contactPhone}, reason}`; draft/returned only |
| POST `/requests/:id/submit` | Freeze a submitted version; both contact fields required |
| POST `/requests/:id/approve` | Update canonical profile and insert approved revision atomically |
| POST `/requests/:id/reject` or `/return` | Record decision with required reason; canonical profile unchanged |
| POST `/requests/:id/withdraw` | Current guardian withdraws an open request |

Actions take `{version, submissionVersion, reason?}`. `version` is the current optimistic request version; `submissionVersion` is the immutable submitted snapshot number. Retrying the same actor/action/version/reason never applies the action twice. Conflicting versions and concurrent terminal decisions fail with 409. Returned requests must be saved and submitted again. Approval checks the base profile revision and current submitting guardian eligibility. Self-approval is denied for current family members and anyone who created, edited, or submitted the request.

The legacy contact-only family API never changes people or memberships. The unified native family submission additionally supports approved adult profile and membership changes, but never changes sign-in emails, class placement, or roles. No pre-existing admin path writes the new profile contact fields. Submitted data, approved snapshots, and events are append-only through the service. Approved snapshots record both submitting and approving actor IDs plus time. Historical display names are resolved from current person records; stable IDs preserve attribution.

Parent history is restricted to currently active guardian membership IDs present when a submission/revision was captured. A newly created membership gets current approved data but no automatic access to older history. Do not reactivate an old membership ID to re-link a guardian; create a new membership. The legacy API still supports contact drafts; the unified family form submits directly. Adult relationship changes require independent school review.

Run the dedicated integration suite only against the disposable loopback database `smz_family_profiles_test` with `RUN_FAMILY_PROFILE_TESTS=true`; the Auth `npm run test:profiles` command provisions it and supplies the URL without logging credentials. It covers transactional rollback, optimistic edits, frozen submissions, retry/race safety, scoped visibility, self-approval, revoked reviewers, membership/session revocation, and non-admin registrar approval. Standard `npm run build:auth` and `npm test -w @smz/auth-server` also apply.

Production retention, backups, pagination, restricted registrar scopes, applicant onboarding, and notifications require follow-up. No production migration or deployment is implied by this branch.


## Individual profiles (parents and other admitted adults)

The `/profiles/person` page supports requesting changes to one's own display name, personal contact phone, and contact email, and the same fields for any current adult parent or guardian in the same active family. The family page now uses the unified single-submit workflow above; standalone personal pages retain their existing request workflow. Children remain visible in the relationship graph and are not editable through the adult profile form. The profile subject and request creator can save, submit, or withdraw a request while their current edit authority remains valid; other guardians cannot take over an existing request. Delegated applicants can track requests they created, but cannot read the subject's other requests or revision history. Ordinary users cannot browse unrelated families. Explicit admin/registrar review authority remains separate. Expired, future, inactive memberships and disabled people are excluded. Admins and appointed registrars review requests; the subject, request creator, prior request participants, and current same-family guardians cannot review a change. Contact email is separate from sign-in email and does not change login credentials, roles, or family memberships.

Auth owns `/api/directory/v1/person-profiles` with `people/:id` in place of the family collection, and the same request actions. Enable the independent `personProfiles: true` confidential-client capability under **家庭與個人資料權限**. Apply additive migration `0006_person_profile_approvals` after `0005`. The native client requires both capabilities to be explicitly enabled by an admin.

The target adult does not need a login account. Approval rechecks the actual submitter’s current admission and edit authority; revoked, expired, or future family memberships cannot authorize changes.

Approval atomically synchronizes the directory display name and Auth account name and preserves a baseline plus every approved revision. Administrative name corrections also append revisions and invalidate stale pending requests. Direct account name updates are blocked; Google sign-in does not overwrite the approved name. Submitted versions, return/rejection reasons, and decisions remain in history.
