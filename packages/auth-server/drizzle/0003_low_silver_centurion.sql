CREATE SCHEMA "application";
--> statement-breakpoint
CREATE TABLE "application"."express_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "express_sessions_expire_idx" ON "application"."express_sessions" USING btree ("expire");