CREATE TABLE "directory"."person_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_revision" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submission_version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_request_status" CHECK ("directory"."person_change_requests"."status" in ('draft','pending','returned','approved','rejected','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "directory"."person_profile_revisions" (
	"person_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"data" jsonb NOT NULL,
	"source" text NOT NULL,
	"request_id" uuid,
	"submission_version" integer,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_profile_revisions_person_id_revision_pk" PRIMARY KEY("person_id","revision"),
	CONSTRAINT "person_revision_source" CHECK ("directory"."person_profile_revisions"."source" in ('baseline','request','admin'))
);
--> statement-breakpoint
CREATE TABLE "directory"."person_profiles" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "person_profile_revision_nonnegative" CHECK ("directory"."person_profiles"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "directory"."person_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"submission_version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory"."person_request_submissions" (
	"request_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"reason" text NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_request_submissions_request_id_version_pk" PRIMARY KEY("request_id","version")
);
--> statement-breakpoint
ALTER TABLE "directory"."person_change_requests" ADD CONSTRAINT "person_change_requests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_change_requests" ADD CONSTRAINT "person_change_requests_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_profile_revisions" ADD CONSTRAINT "person_profile_revisions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_profile_revisions" ADD CONSTRAINT "person_profile_revisions_request_id_person_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."person_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_profile_revisions" ADD CONSTRAINT "person_profile_revisions_submitted_by_people_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_profile_revisions" ADD CONSTRAINT "person_profile_revisions_approved_by_people_id_fk" FOREIGN KEY ("approved_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_profiles" ADD CONSTRAINT "person_profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_request_events" ADD CONSTRAINT "person_request_events_request_id_person_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."person_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_request_events" ADD CONSTRAINT "person_request_events_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_request_submissions" ADD CONSTRAINT "person_request_submissions_request_id_person_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "directory"."person_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory"."person_request_submissions" ADD CONSTRAINT "person_request_submissions_submitted_by_people_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "directory"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_one_open_request" ON "directory"."person_change_requests" USING btree ("person_id") WHERE "directory"."person_change_requests"."status" in ('draft','pending','returned');--> statement-breakpoint
CREATE INDEX "person_requests_person_idx" ON "directory"."person_change_requests" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_revision_request_unique" ON "directory"."person_profile_revisions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "person_events_request_idx" ON "directory"."person_request_events" USING btree ("request_id");