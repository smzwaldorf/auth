import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { directorySchema, families, people } from "./directory-schema.js";
export const familyProfileReviewers = directorySchema.table(
  "family_profile_reviewers",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => people.id),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => people.id),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);
export const familyProfiles = directorySchema.table(
  "family_profiles",
  {
    familyId: uuid("family_id")
      .primaryKey()
      .references(() => families.id),
    revision: integer("revision").default(0).notNull(),
    data: jsonb("data")
      .notNull()
      .default({ mailingAddress: "", contactPhone: "" }),
  },
  (t) => [check("profile_revision_nonnegative", sql`${t.revision} >= 0`)],
);
export const familyChangeRequests = directorySchema.table(
  "family_change_requests",
  {
    id: uuid("id").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    status: text("status").notNull().default("draft"),
    baseRevision: integer("base_revision").notNull(),
    version: integer("version").notNull().default(1),
    submissionVersion: integer("submission_version").notNull().default(0),
    data: jsonb("data").notNull(),
    reason: text("reason").notNull().default(""),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("family_one_open_request")
      .on(t.familyId)
      .where(sql`${t.status} in ('draft','pending','returned')`),
    check(
      "family_request_status",
      sql`${t.status} in ('draft','pending','returned','approved','rejected','withdrawn')`,
    ),
  ],
);
export const familyRequestSubmissions = directorySchema.table(
  "family_request_submissions",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => familyChangeRequests.id),
    version: integer("version").notNull(),
    baseRevision: integer("base_revision").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    data: jsonb("data").notNull(),
    reason: text("reason").notNull(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => people.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Snapshot of membership IDs, not names: newly linked guardians cannot see earlier submissions.
    viewerMembershipIds: jsonb("viewer_membership_ids").notNull(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.version] })],
);
export const familyProfileRevisions = directorySchema.table(
  "family_profile_revisions",
  {
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    revision: integer("revision").notNull(),
    data: jsonb("data").notNull(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => familyChangeRequests.id),
    submissionVersion: integer("submission_version").notNull(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => people.id),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => people.id),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    viewerMembershipIds: jsonb("viewer_membership_ids").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.familyId, t.revision] }),
    uniqueIndex("family_revision_request_unique").on(t.requestId),
  ],
);
export const familyRequestEvents = directorySchema.table(
  "family_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => familyChangeRequests.id),
    action: text("action").notNull(),
    version: integer("version").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => people.id),
    reason: text("reason").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);
