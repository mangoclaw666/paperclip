import { and, count, eq, getTableName, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  agentApiKeys,
  agentConfigRevisions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueLabels,
  issueReadStates,
  issueRecoveryActions,
  issueReferenceMentions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  labels,
  projects,
  projectGoals,
  projectWorkspaces,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  costEvents,
  financeEvents,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  companySecretBindings,
  companySecretProviderConfigs,
  companyUserSidebarPreferences,
  secretAccessEvents,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  budgetPolicies,
  budgetIncidents,
  documents,
  documentRevisions,
  environments,
  environmentLeases,
  executionWorkspaces,
  workspaceOperations,
  workspaceRuntimeServices,
  feedbackExports,
  feedbackVotes,
  inboxDismissals,
  pluginCompanySettings,
  pluginManagedResources,
  routines,
  routineRevisions,
  routineTriggers,
  routineRuns,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
  const environmentsSvc = environmentService(db);

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    externalSource: companies.externalSource,
    sharedInstructions: companies.sharedInstructions,
    bootstrapTemplate: companies.bootstrapTemplate,
    heartbeatTemplate: companies.heartbeatTemplate,
    // fork_mangoclaw: project + goal identifier prefix/counter (migration 0088).
    projectPrefix: companies.projectPrefix,
    projectCounter: companies.projectCounter,
    goalPrefix: companies.goalPrefix,
    goalCounter: companies.goalCounter,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    const constraint = typeof error === "object" && error !== null && "constraint" in error
      ? (error as { constraint?: string }).constraint
      : typeof error === "object" && error !== null && "constraint_name" in error
        ? (error as { constraint_name?: string }).constraint_name
        : undefined;
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "23505"
      && constraint === "companies_issue_prefix_idx";
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
    ) =>
      db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const updated = await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        return enrichCompany(hydrated);
      }),

    archive: (id: string) =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(companies)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return enrichCompany(hydrated);
      }),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // fork_mangoclaw: hard-delete a company + all descendant rows.
        //
        // WHY THIS IS LONG (and why we don't just `DELETE FROM companies`):
        //   PaperClip's FK constraints default to NO ACTION (no ON DELETE CASCADE
        //   on any table). So a plain DELETE on companies fails the moment any
        //   child row exists. We have to walk every table with a `company_id`
        //   column in dependency order.
        //
        // WHY ARCHIVE IS THE NORMAL FLOW:
        //   `archive(id)` flips `status='archived'` and keeps the data. That's
        //   the right answer 90% of the time — audit trail, undo, no FK risk.
        //   `remove()` is ONLY for test/abandoned companies whose data you
        //   genuinely want gone forever. Archive does NOT free disk; this does.
        //
        // ⚠️  IF YOU ADD A NEW TABLE WITH A `company_id` COLUMN:
        //   1. Add it to COMPANY_CASCADE_TABLES below in the correct
        //      dependency order (children before parents).
        //   2. The drift guard at the end will throw at runtime if you forget,
        //      so this can't silently break.
        //   3. Consider adding ON DELETE CASCADE to the new FK instead — that
        //      makes manual maintenance here unnecessary for that table.
        const COMPANY_CASCADE_TABLES = [
          // Issue children (FK → issues)
          issueThreadInteractions, issueAttachments, issueDocuments, issueComments,
          issueApprovals, issueExecutionDecisions, issueInboxArchives, issueLabels,
          issueReadStates, issueRecoveryActions, issueReferenceMentions, issueRelations,
          issueTreeHoldMembers, issueTreeHolds, issueWorkProducts,
          // Heartbeat children (FK → heartbeat_runs)
          heartbeatRunWatchdogDecisions, heartbeatRunEvents,
          // Agent children (FK → agents)
          agentApiKeys, agentConfigRevisions, agentRuntimeState,
          agentTaskSessions,
          // agentWakeupRequests is deferred to AFTER heartbeatRuns — see note
          // at the heartbeatRuns line. heartbeat_runs.wakeup_request_id has no
          // ON DELETE action, so deleting wakeup_requests first violates the
          // FK on any company that has accumulated heartbeat runs.
          // Approval children (FK → approvals)
          approvalComments,
          // Document children
          documentRevisions,
          // Project children
          projectGoals, projectWorkspaces,
          // Environment children
          environmentLeases, executionWorkspaces, workspaceOperations, workspaceRuntimeServices,
          // Secret children
          companySecretBindings, secretAccessEvents, companySecretProviderConfigs,
          // Budget children
          budgetIncidents,
          // Feedback
          feedbackExports, feedbackVotes,
          // Plugin
          pluginManagedResources, pluginCompanySettings,
          // Routine children (FK → routines)
          routineRuns, routineTriggers, routineRevisions, routines,
          // Primary entities (referenced by children above)
          heartbeatRuns,
          // agentWakeupRequests must come AFTER heartbeatRuns (heartbeat_runs.wakeup_request_id FK).
          agentWakeupRequests,
          documents,
          issues,
          goals,
          projects,
          environments,
          companySecrets,
          assets,
          companyLogos,
          agents,
          // Company-direct (no further dependents within this set)
          activityLog,
          invites,
          joinRequests,
          principalPermissionGrants,
          companyMemberships,
          companySkills,
          companyUserSidebarPreferences,
          costEvents,
          financeEvents,
          approvals,
          budgetPolicies,
          labels,
          inboxDismissals,
        ];

        // fork_mangoclaw: clear FK references to heartbeat_runs that schema-level
        // ON DELETE doesn't handle. Three columns have no onDelete action defined
        // (NO ACTION = block), so DELETE FROM heartbeat_runs would fail on any
        // company that ever logged activity, cost events, or finance events:
        //
        //   - activity_log.run_id
        //   - cost_events.heartbeat_run_id
        //   - finance_events.heartbeat_run_id
        //
        // Other heartbeat_runs FKs (issues, environment_leases, secret_access_events,
        // workspace_operations, retry_of_run_id, etc.) already declare
        // `onDelete: "set null"` or `"cascade"` in schema, so Postgres handles
        // those automatically — we deliberately don't touch them here.
        //
        // ⚠️  If you add a new column referencing heartbeat_runs without
        // declaring onDelete in schema, add it here OR add `onDelete` to the
        // schema (preferred). There's no drift guard for this — sorry.
        const runIdsSubq = tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));
        await tx.update(activityLog).set({ runId: null }).where(inArray(activityLog.runId, runIdsSubq));
        await tx.update(costEvents).set({ heartbeatRunId: null }).where(inArray(costEvents.heartbeatRunId, runIdsSubq));
        await tx.update(financeEvents).set({ heartbeatRunId: null }).where(inArray(financeEvents.heartbeatRunId, runIdsSubq));

        for (const tbl of COMPANY_CASCADE_TABLES) {
          // Each table is guaranteed to have a `companyId` column (the drift
          // guard below verifies this at runtime). Drizzle's per-table column
          // type is too narrow for a generic loop, so cast through `unknown`.
          const companyIdCol = (tbl as unknown as { companyId: typeof companies.id }).companyId;
          await tx.delete(tbl).where(eq(companyIdCol, id));
        }

        // Drift guard: catch tables added to the schema but not to the list above.
        // Uses information_schema so it's robust to renames/additions.
        const knownTableNames = new Set<string>([
          ...COMPANY_CASCADE_TABLES.map((t) => getTableName(t)),
          getTableName(companies),
        ]);
        const allCompanyScoped = await tx.execute<{ table_name: string }>(sql`
          SELECT table_name FROM information_schema.columns
          WHERE column_name = 'company_id' AND table_schema = 'public'
        `);
        // postgres.js returns the array directly; pg-style drivers return { rows }.
        const rowsList = Array.isArray(allCompanyScoped)
          ? (allCompanyScoped as Array<{ table_name: string }>)
          : ((allCompanyScoped as { rows: Array<{ table_name: string }> }).rows ?? []);
        const unknownTables = rowsList
          .map((r) => r.table_name)
          .filter((name) => !knownTableNames.has(name));
        if (unknownTables.length > 0) {
          throw new Error(
            `company.remove drift guard: tables with company_id not in COMPANY_CASCADE_TABLES: ${unknownTables.join(", ")}. ` +
            `Add them to the cascade list in dependency order, or add ON DELETE CASCADE to their FK.`,
          );
        }

        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
