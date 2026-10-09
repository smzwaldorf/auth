import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { directorySchema, people } from "./directory-schema.js";
import { familyChangeRequests } from "./family-profile-schema.js";
export const personProfiles = directorySchema.table(
  "person_profiles",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => people.id),
    revision: integer("revision").notNull().default(0),
    data: jsonb("data").notNull(),
  },
  (t) => [
    check("person_profile_revision_nonnegative", sql`${t.revision} >= 0`),
  ],
);
export const personChangeRequests = directorySchema.table(
  "person_change_requests",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
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
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("person_one_open_request")
      .on(t.personId)
      .where(sql`${t.status} in ('draft','pending','returned')`),
    index("person_requests_person_idx").on(t.personId),
    check(
      "person_request_status",
      sql`${t.status} in ('draft','pending','returned','approved','rejected','withdrawn')`,
    ),
  ],
);
export const personRequestSubmissions = directorySchema.table(
  "person_request_submissions",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => personChangeRequests.id),
    version: integer("version").notNull(),
    baseRevision: integer("base_revision").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    data: jsonb("data").notNull(),
    reason: text("reason").notNull(),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => people.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.version] })],
);
export const personProfileRevisions = directorySchema.table(
  "person_profile_revisions",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    revision: integer("revision").notNull(),
    data: jsonb("data").notNull(),
    source: text("source").notNull(),
    familyRequestId: uuid("family_request_id").references(() => familyChangeRequests.id),
    requestId: uuid("request_id").references(() => personChangeRequests.id),
    submissionVersion: integer("submission_version"),
    submittedBy: uuid("submitted_by").references(() => people.id),
    approvedBy: uuid("approved_by").references(() => people.id),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.revision] }),
    uniqueIndex("person_revision_request_unique").on(t.requestId),
    check(
      "person_revision_source",
      sql`${t.source} in ('baseline','request','admin','family')`,
    ),
  ],
);
export const personRequestEvents = directorySchema.table(
  "person_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => personChangeRequests.id),
    action: text("action").notNull(),
    version: integer("version").notNull(),
    submissionVersion: integer("submission_version").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => people.id),
    reason: text("reason").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("person_events_request_idx").on(t.requestId)],
);
