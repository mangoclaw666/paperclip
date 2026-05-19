-- fork_mangoclaw: project + goal identifier prefix/counter on companies.
-- Mirrors the existing issue_prefix + issue_counter pattern so projects and
-- goals get the same auto-numbered stable identifier system as issues.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "project_prefix" text DEFAULT 'PRJ';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "project_counter" integer NOT NULL DEFAULT 0;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "goal_prefix" text DEFAULT '';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "goal_counter" integer NOT NULL DEFAULT 0;
