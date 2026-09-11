ALTER TABLE "auth"."account" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "auth"."account"
SET "issuer" = CASE
	WHEN "provider_id" = 'google' THEN 'https://accounts.google.com'
	ELSE 'local:oauth:' || "provider_id"
END;--> statement-breakpoint
ALTER TABLE "auth"."account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
DROP INDEX "auth"."account_provider_account_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_unique" ON "auth"."account" USING btree ("issuer","account_id");
