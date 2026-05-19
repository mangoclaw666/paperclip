-- fork_mangoclaw: project auto-numbered identifier + manual sort order.
-- project_number is the per-company auto-increment (1, 2, 3, …) used to derive
-- the human-facing identifier like "MK-01". sort_order lets the user drag-and-
-- drop reorder projects in the dashboard independent of createdAt.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_number" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "identifier" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "projects_company_sort_idx" ON "projects" ("company_id", "sort_order");
CREATE UNIQUE INDEX IF NOT EXISTS "projects_company_identifier_uniq" ON "projects" ("company_id", "identifier");
