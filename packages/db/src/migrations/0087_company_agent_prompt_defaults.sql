ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "shared_instructions" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "bootstrap_template" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "heartbeat_template" text;
