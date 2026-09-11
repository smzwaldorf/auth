CREATE SCHEMA IF NOT EXISTS app_b;
CREATE TABLE IF NOT EXISTS "app_b"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_b_session_expiry_idx" ON "app_b"."session" USING btree ("expires_at");