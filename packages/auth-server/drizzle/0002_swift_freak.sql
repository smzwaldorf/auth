CREATE TABLE "directory"."development_login_accounts" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory"."development_login_accounts" ADD CONSTRAINT "development_login_accounts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "directory"."people"("id") ON DELETE cascade ON UPDATE no action;