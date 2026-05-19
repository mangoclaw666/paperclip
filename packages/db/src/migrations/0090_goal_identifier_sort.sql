-- fork_mangoclaw: goal auto-numbered identifier + manual sort order.
-- Same pattern as projects (0089). Goal prefix on companies defaults to empty
-- string so identifier reads as just the zero-padded number ("001", "002")
-- — Monday's preference. Mission/OKR/KR distinction stays in the existing
-- `level` column.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "goal_number" integer;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "identifier" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "goals_company_parent_sort_idx" ON "goals" ("company_id", "parent_id", "sort_order");
CREATE UNIQUE INDEX IF NOT EXISTS "goals_company_identifier_uniq" ON "goals" ("company_id", "identifier");
