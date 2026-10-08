CREATE TABLE "directory"."family_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_revision" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submission_version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_request_status" CHECK ("directory"."family_change_requests"."status" in ('draft','pending','returned','approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "directory"."family_profile_reviewers" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory"."family_profile_revisions" (
	"family_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"submission_version" integer NOT NULL,
	"submitted_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewer_membership_ids" jsonb NOT NULL,
	CONSTRAINT "family_profile_revisions_family_id_revision_pk" PRIMARY KEY("family_id","revision")
);
--> statement-breakpoint
CREATE TABLE "directory"."family_profiles" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{"mailingAddress":"","contactPhone":""}'::jsonb NOT NULL,
	CONSTRAINT "profile_revision_nonnegative" CHECK ("directory"."family_profiles"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "directory"."family_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory"."family_request_submissions" (
	"request_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewer_membership_ids" jsonb NOT NULL,
	CONSTRAINT "family_request_submissions_request_id_version_pk" PRIMARY KEY("request_id","version")
);
--> statement-breakpoint
ALTER TABLE "directory"."family_change_requests" ADD CONSTRAINT "family_change_requests_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "directory"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_change_requests" ADD CONSTRAINT "family_change_requests_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_reviewers" ADD CONSTRAINT "family_profile_reviewers_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_reviewers" ADD CONSTRAINT "family_profile_reviewers_granted_by_people_id_fk" FOREIGN KEY ("granted_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_revisions" ADD CONSTRAINT "family_profile_revisions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "directory"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_revisions" ADD CONSTRAINT "family_profile_revisions_request_id_family_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."family_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_revisions" ADD CONSTRAINT "family_profile_revisions_submitted_by_people_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profile_revisions" ADD CONSTRAINT "family_profile_revisions_approved_by_people_id_fk" FOREIGN KEY ("approved_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_profiles" ADD CONSTRAINT "family_profiles_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "directory"."families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_request_events" ADD CONSTRAINT "family_request_events_request_id_family_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."family_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_request_events" ADD CONSTRAINT "family_request_events_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_request_submissions" ADD CONSTRAINT "family_request_submissions_request_id_family_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."family_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."family_request_submissions" ADD CONSTRAINT "family_request_submissions_submitted_by_people_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_one_open_request" ON "directory"."family_change_requests" USING btree ("family_id") WHERE "directory"."family_change_requests"."status" in ('draft','pending','returned');--> statement-breakpoint
CREATE UNIQUE INDEX "family_revision_request_unique" ON "directory"."family_profile_revisions" USING btree ("request_id");