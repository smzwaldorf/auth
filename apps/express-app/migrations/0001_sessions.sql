CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS "auth"."app_b_session" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_b_session_expiry_idx" ON "auth"."app_b_session" USING btree ("expires_at");