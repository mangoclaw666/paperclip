import { pgTable, uuid, text, integer, timestamp, date, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    env: jsonb("env").$type<AgentEnvConfig>(),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // fork_mangoclaw: auto-numbered identifier (migration 0089). Mirrors issues.issue_number/identifier.
    projectNumber: integer("project_number"),
    identifier: text("identifier"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
    companySortIdx: index("projects_company_sort_idx").on(table.companyId, table.sortOrder),
    companyIdentifierUniq: uniqueIndex("projects_company_identifier_uniq").on(table.companyId, table.identifier),
  }),
);
