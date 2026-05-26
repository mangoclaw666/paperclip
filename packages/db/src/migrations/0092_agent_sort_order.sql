-- fork_mangoclaw: agent manual sort order for dashboard / sidebar reordering.
-- Default 0; existing rows seeded with row_number() so initial order matches
-- name-based listing. UI bumps order by ±10 on each move so future inserts
-- can land between two existing rows without a full renumber.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "agents_company_sort_idx" ON "agents" ("company_id", "sort_order");

-- Seed: per company, assign sort_order in 10-step increments based on current
-- name order. Only touches rows still at default 0.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY company_id ORDER BY name) * 10 AS new_order
  FROM agents
  WHERE sort_order = 0
)
UPDATE agents SET sort_order = ranked.new_order
FROM ranked
WHERE agents.id = ranked.id;
