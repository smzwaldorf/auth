import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { oauthClient } from "./auth-schema.js";

export const directorySchema = pgSchema("directory");

export const personKind = directorySchema.enum("person_kind", ["adult", "student"]);
export const lifecycleStatus = directorySchema.enum("lifecycle_status", ["active", "disabled"]);
export const personRole = directorySchema.enum("person_role", ["admin", "teacher", "parent", "student"]);
export const relationship = directorySchema.enum("family_relationship", ["father", "mother", "guardian", "child"]);
export const membershipStatus = directorySchema.enum("membership_status", ["active", "inactive"]);
export const classRelationship = directorySchema.enum("class_relationship", ["teacher", "student"]);
export const appAccessStatus = directorySchema.enum("app_access_status", ["active", "revoked"]);
export const invitationStatus = directorySchema.enum("invitation_status", ["pending", "activated", "expired", "revoked"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const people = directorySchema.table(
  "people",
  {
    id: uuid("id").primaryKey(),
    kind: personKind("kind").notNull(),
    displayName: text("display_name").notNull(),
    normalizedLoginEmail: text("normalized_login_email"),
    status: lifecycleStatus("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("people_normalized_login_email_unique")
      .on(table.normalizedLoginEmail)
      .where(sql`${table.normalizedLoginEmail} is not null`),
  ],
);

export const personRoles = directorySchema.table(
  "person_roles",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: personRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.role] })],
);

export const families = directorySchema.table("families", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull(),
  status: lifecycleStatus("status").default("active").notNull(),
  ...timestamps,
});

export const familyMemberships = directorySchema.table(
  "family_memberships",
  {
    id: uuid("id").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    relationship: relationship("relationship").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    ...timestamps,
  },
  (table) => [
    index("family_memberships_person_idx").on(table.personId),
    index("family_memberships_family_idx").on(table.familyId),
    uniqueIndex("family_memberships_active_unique")
      .on(table.familyId, table.personId, table.relationship)
      .where(sql`${table.status} = 'active' and ${table.endsOn} is null`),
  ],
);

export const classes = directorySchema.table("classes", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull(),
  status: lifecycleStatus("status").default("active").notNull(),
  ...timestamps,
});

export const classMemberships = directorySchema.table(
  "class_memberships",
  {
    id: uuid("id").primaryKey(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    relationship: classRelationship("relationship").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    ...timestamps,
  },
  (table) => [
    index("class_memberships_person_idx").on(table.personId),
    index("class_memberships_class_idx").on(table.classId),
    uniqueIndex("class_memberships_active_unique")
      .on(table.classId, table.personId, table.relationship)
      .where(sql`${table.status} = 'active' and ${table.endsOn} is null`),
  ],
);

export const applications = directorySchema.table("applications", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  publicOrigin: text("public_origin"),
  enabled: boolean("enabled").default(true).notNull(),
  ...timestamps,
});

export const appAccess = directorySchema.table(
  "app_access",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => applications.clientId, { onDelete: "cascade" }),
    status: appAccessStatus("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.personId, table.clientId] })],
);

export const loginInvitations = directorySchema.table(
  "login_invitations",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    status: invitationStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("login_invitations_email_unique").on(table.normalizedEmail),
    uniqueIndex("login_invitations_person_unique").on(table.personId),
  ],
);

// This is an allowlist, not an authentication bypass.  It exists solely to
// make local and test OIDC journeys repeatable without Google or email.
export const developmentLoginAccounts = directorySchema.table(
  "development_login_accounts",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => people.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    ...timestamps,
  },
);

export const auditEvents = directorySchema.table(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    personId: uuid("person_id"),
    clientId: text("client_id"),
    actor: text("actor").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_person_idx").on(table.personId),
    index("audit_events_occurred_at_idx").on(table.occurredAt),
  ],
);
