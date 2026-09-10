CREATE TABLE "auth"."app_b_session" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_b_session_expiry_idx" ON "auth"."app_b_session" USING btree ("expires_at");