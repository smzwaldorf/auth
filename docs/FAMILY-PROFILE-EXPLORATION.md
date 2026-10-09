# Family information and approved changes

Status: original exploration, 2026-09-22. A bounded contact-profile pilot has since been implemented; see [implementation and verification](FAMILY-PROFILES.md). The implementation now lives entirely in smz-auth, including the native portal. Earlier Forms placement proposals below are superseded; the broader proposals are not all shipped.

## Recommendation

Add a dedicated “Family information / 家庭資料” workflow, separate from activity responses. Parents submit a proposed profile; an administrator or designated registrar reviews it before it becomes official. Subsequent edits create change requests against the latest approved revision. Pending information never replaces approved information in directory reads or other applications.

Use Forms for the parent experience and Auth's directory domain for authoritative records, request decisions, and approved revision history. Keep these writes in one owning service/database transaction. Forms must not write directly into Auth tables. A fixed, typed form is a better initial fit than arbitrary organizer-authored questions: each editable field needs a known owner, validation rule, permission, and approval effect. The existing renderer may be reused for presentation, but a questionnaire submission must never implicitly update directory fields.

## Existing implementation and gaps

| Area | Verified local implementation | Required addition |
| --- | --- | --- |
| Sign-in and family context | Forms uses server-side OIDC sessions and live directory context (`server/auth.ts`, `server/types.ts`) | Purpose-specific profile read/write permissions and field allowlists |
| Form responses | Immediate shared-family saves with optimistic concurrency and immutable response snapshots (`server/service.ts`, `db/001_initial.sql`) | Separate pending request and approved profile states |
| Directory | Auth owns people, families, effective family/class memberships and audit events (`../smz-auth/packages/auth-server/src/db/directory-schema.ts`) | Profile fields, immutable approved revisions, and review requests |
| Administration | Auth has direct directory editing and a family creation wizard (`../smz-auth/packages/auth-server/src/admin/routes.ts`) | Review inbox, field differences, decision reasons, transactional approval |
| Registrar | Directory role enum currently contains admin, teacher, parent, student | Explicit registrar permission; never inherit approval from teacher or activity-manager access |
| API consumed by Forms | `/api/directory/v1/me/directory` exposes names and relationships | Versioned profile/request API; existing directory reads are insufficient |

The inspected schema has no mailing address, contact phone, emergency-contact profile, or general profile revision table. Existing audit events and membership dates are useful but do not establish complete profile reconstruction. Existing records can receive a baseline revision at rollout; do not invent earlier history.

## User experience

1. Open 家庭資料 and choose an eligible family. Show the approved information, revision date, and any pending request separately.
2. Choose 首次填寫 or 申請修改. Prefill only authorized fields from the approved profile. Existing directory names and relationships remain visible even before the first profile submission.
3. Save a draft, review the proposed changes, supply an optional explanation, and submit. Display a receipt and 待審核 status.
4. The registrar sees a queue and a three-column review: field, current approved value, proposed value. Show author, submission version, date, and reason.
5. Approve the complete request, reject with a reason, or return it for correction. Approval creates the next official revision; rejection leaves the current profile unchanged.
6. Parents see the decision and a history of submissions and approved changes. Returned requests can be revised and resubmitted; each submitted version remains preserved.

Suggested lifecycle: draft → pending → approved / rejected / returned / withdrawn. Returned → draft → pending creates a new immutable submission version. Submitted content is frozen. Approval must identify the exact submission version reviewed. For the pilot, allow one open request per family with optimistic locking for shared guardian edits; record each actor. Disallow self-approval, including administrators submitting for their own family.

## Initial collection versus new-family onboarding

These are different entry paths:

- Existing approved guardian, existing family: first collection can add missing profile details, and later requests amend them. Current family authorization applies throughout.
- Applicant without a linked family or approved login: current Forms admission cannot support this. A later registrar-issued, expiring intake invitation can permit a narrowly scoped application without granting directory access. Approval must resolve duplicates and explicitly create/link people and family memberships. Never match or merge automatically by name/email, and never grant account access just because someone submitted a form.

Start with existing families. New-family admission is a separate implementation phase, not an implied consequence of profile approval.

## Proposed field scope

| Field group | Suggested handling |
| --- | --- |
| Mailing address and contact phone | First pilot; approved changes only |
| Contact email | Separate contact information from sign-in email; do not change login identity through this form |
| Parent/child names | Display existing values initially; add a dedicated correction path later |
| Guardianship, adding/removing members | Separate privileged review because changes affect access; preserve ended memberships |
| Class, student enrollment, roles, account status | School-managed; excluded from parent profile edits |
| Emergency contacts, medical details, identity documents | Defer until purpose, visibility, and retention are explicitly defined |

Confirm the exact first fields and whether contacts belong to a person or the household before implementation. A person's shared details must have one canonical owner even if the person belongs to multiple families.

## Data and transaction design

Proposed records in the directory-owning service:

- `family_profiles`: family ID, current approved revision, allowlisted household data, schema version.
- `family_profile_revisions`: immutable approved snapshot, revision, prior revision, originating request/submission version, submitting actor, approving actor, approved timestamp, and change summary.
- `family_change_requests`: family ID, status, base approved revision, draft version, creator, timestamps, current submitted version, decision actor/reason.
- `family_request_submissions`: immutable proposed snapshot and typed changes, base revision, schema/form version, submitting actor, timestamp. Preserve exact values presented for approval.
- `family_request_events`: submission, return, withdrawal and decision events, actor, timestamp, and reason; internal review notes separated from parent-visible feedback.

On approval, authorize the reviewer live, lock the request and affected canonical records, verify pending status and exact submitted version, compare base revisions, validate allowlisted changes again, then update the profile, insert its revision, record the decision/event, and commit atomically. Repeated approval with the same idempotency key returns the same result. Competing approve/reject/withdraw actions can produce only one outcome.

If approved data changed after the request was drafted, show a conflict and require a refreshed submission and review. Do not silently overwrite or automatically merge in the pilot. Future person-level edits must check every affected person's version, including edits from another family. Existing admin editing paths must participate in the same revision mechanism for covered fields, otherwise history and conflict checks are incomplete.

Restoration is a new request based on an old revision and reviewed against current data; never delete later revisions or rewind records in place. Notifications, if added, use an outbox after approval commits. Email failure must not reverse an approved change.

## Proposed API boundary

These endpoints do not exist yet; names are illustrative.

| Operation | Contract |
| --- | --- |
| Read profile | `GET /families/:id/profile` → approved fields, revision, permitted actions |
| Create/save request | `POST /families/:id/change-requests`, `PATCH /change-requests/:id` with expected draft/base version |
| Submit | `POST /change-requests/:id/submit` → immutable submission version, receipt |
| Review queue/detail | `GET /change-requests`, `GET /change-requests/:id` with registrar scope enforced |
| Decision | `POST /change-requests/:id/approve`, `/reject`, `/return` with expected submission version and decision reason |
| Withdraw | `POST /change-requests/:id/withdraw` while pending |
| History | `GET /families/:id/profile/revisions` with field- and audience-filtered results |

Forms forwards authenticated actor context through an explicitly authorized API contract. Do not reuse `directory:access` as broad mutation permission or trust caller-provided actor IDs. Admission, current family links, registrar scope, and approval rights must be enforced by the owning service on every operation.

## Access and history

Current authorized guardians may share drafts and requests for ordinary household contact fields. Historical relationship snapshots never confer access. Removed guardians lose access to current data and history. Parent-visible history excludes internal review notes and any fields they cannot currently read; a newly linked guardian should not automatically receive all older household/person history. Establish a visibility start point or explicit registrar grant.

Registrars receive only scoped profile-review capabilities; activity managers and teachers receive none by default. Sensitive relationship disputes need a restricted workflow rather than an ordinary shared-family draft. Audit who submitted, reviewed, approved, returned, rejected, and restored records. Keep full profile values out of operational logs. Define retention for approved revisions, rejected requests, abandoned drafts, and backups before production; “revision history” does not imply unrestricted retention or access.

## Bounded implementation sequence

1. Confirm contact fields and ownership; implement the profile, revision, request state machine, API permissions, and reviewer capability in Auth. Make covered direct-admin changes revision-aware.
2. Add Forms screens for approved details, shared draft, change preview, receipt/status, and scoped history. Add the registrar queue and review screen in Auth administration.
3. Prove one existing family's initial contact submission and later correction end to end. Then expand field coverage and implement invitation-based new-family intake separately.

Acceptance checks: pending/rejected requests leave official data unchanged; one approval creates exactly one revision; two guardians cannot overwrite each other's draft; stale approval conflicts; approve/withdraw races have one winner; request retry does not duplicate records; another family cannot access the request by ID; teachers/managers cannot approve; self-approval is blocked; revoked guardians/reviewers lose access; outages fail closed; direct-admin edits are revisioned; old snapshots do not leak newly restricted fields; restoration adds history instead of erasing it.

## Product decisions still needed

- Does the first release cover existing families only, or also families without school accounts?
- Which precise household/person fields belong in the first form?
- Who is the registrar, and is review school-wide or scoped?
- Which historical details may guardians see, and for how long should each category be retained?

Working default: existing families, household mailing address and contact phone, explicitly appointed school-wide reviewers, whole-request approval, parent-visible decisions and permitted profile revisions.
