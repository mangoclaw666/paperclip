import { Command } from "commander";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import pc from "picocolors";
import type {
  CompanyPortabilityImportResult,
  CompanyExternalSource,
} from "@paperclipai/shared";
import { ApiRequestError } from "../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";
import {
  resolveCompanyImportApiPath,
  resolveInlineSourceFromPath,
} from "./client/company.js";

interface HubSyncOptions extends BaseClientOptions {
  path?: string;
  collision?: "rename" | "skip" | "replace";
  newCompanyName?: string;
  skipGoals?: boolean;
  skipExternalSource?: boolean;
  syncCommand?: string;
  workspacePath?: string;
}

interface GoalEntry {
  slug: string;
  title: string;
  description: string | null;
  level: "company" | "team" | "agent" | "task";
  status: "planned" | "active" | "achieved" | "cancelled";
}

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

async function collectGoals(hubRoot: string): Promise<GoalEntry[]> {
  const goalsDir = path.join(hubRoot, "goals");
  let entries: string[];
  try { entries = await readdir(goalsDir); } catch { return []; }
  const out: GoalEntry[] = [];
  for (const slug of entries) {
    const goalFile = path.join(goalsDir, slug, "GOAL.md");
    try {
      const stats = await stat(goalFile);
      if (!stats.isFile()) continue;
    } catch { continue; }
    const text = await readFile(goalFile, "utf-8");
    const { meta, body } = parseFrontmatter(text);
    const firstHeading = body.split("\n").find((l) => l.startsWith("# "))?.replace(/^#\s+/, "").trim();
    const rawStatus = String(meta.status ?? "active");
    const status = (rawStatus === "in_progress" ? "active" : rawStatus) as GoalEntry["status"];
    out.push({
      slug,
      title: firstHeading || slug.replace(/-/g, " "),
      description: body || null,
      level: (String(meta.level ?? "company")) as GoalEntry["level"],
      status,
    });
  }
  return out;
}

export function registerHubCommands(program: Command): void {
  const hub = program.command("hub").description("Sync a local _hub/ portable package to a Paperclip instance");

  addCommonClientOptions(
    hub
      .command("sync")
      .description("Walk ./_hub (or --path) and push agents + projects + tasks + goals to Paperclip")
      .option("--path <dir>", "Project root containing _hub/ (defaults to current working directory)")
      .option("--collision <mode>", "Collision strategy: rename | skip | replace", "replace")
      .option("--new-company-name <name>", "Name override when creating a new company")
      .option("--skip-goals", "Don't POST goals from _hub/goals/", false)
      .option("--skip-external-source", "Don't PATCH externalSource after import", false)
      .option("--sync-command <cmd>", "Command stored on externalSource for the dashboard 'Re-sync' button")
      .option("--workspace-path <dir>", "workspacePath stored on externalSource (defaults to project root)"),
    { includeCompany: true },
  ).action(async (opts: HubSyncOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      const projectRoot = path.resolve(opts.path?.trim() || process.cwd());
      const hubRoot = path.join(projectRoot, "_hub");
      try { await stat(hubRoot); } catch {
        throw new Error(`No _hub/ folder found at ${hubRoot}. Pass --path or run from a project root.`);
      }

      const inline = await resolveInlineSourceFromPath(hubRoot);
      const collision = (opts.collision ?? "replace").toLowerCase();
      if (!["rename", "skip", "replace"].includes(collision)) {
        throw new Error("--collision must be one of: rename, skip, replace");
      }

      const existingCompanyId = opts.companyId?.trim() || ctx.companyId;
      const target = existingCompanyId
        ? { mode: "existing_company" as const, companyId: existingCompanyId }
        : { mode: "new_company" as const, newCompanyName: opts.newCompanyName?.trim() || path.basename(projectRoot) };

      const applyPath = resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: target.mode,
        companyId: target.mode === "existing_company" ? target.companyId : null,
      });

      console.log(pc.cyan(`[hub sync] importing from ${hubRoot}`));
      const result = await ctx.api.post<CompanyPortabilityImportResult>(applyPath, {
        source: { type: "inline", rootPath: path.basename(projectRoot), files: inline.files },
        target,
        agents: "all",
        collisionStrategy: collision,
      });
      if (!result) throw new Error("Import returned no result.");
      const companyId = result.company.id;
      console.log(pc.green(`[hub sync] company ${companyId} (${result.company.action})`));
      console.log(`  agents=${result.agents.length} projects=${result.projects?.length ?? 0} warnings=${result.warnings.length}`);

      if (!opts.skipGoals) {
        const goals = await collectGoals(hubRoot);
        if (goals.length > 0) {
          console.log(pc.cyan(`[hub sync] posting ${goals.length} goal(s)`));
          for (const g of goals) {
            try {
              await ctx.api.post(`/companies/${companyId}/goals`, {
                title: g.title, description: g.description, level: g.level, status: g.status,
              });
              console.log(`  ${g.slug}: ok`);
            } catch (err) {
              const msg = err instanceof ApiRequestError ? `${err.status} ${err.message}` : String(err);
              console.log(pc.yellow(`  ${g.slug}: ${msg}`));
            }
          }
        }
      }

      if (!opts.skipExternalSource) {
        const externalSource: CompanyExternalSource = {
          type: "filesystem",
          rootPath: hubRoot,
          workspacePath: opts.workspacePath?.trim() || projectRoot,
          syncCommand: opts.syncCommand?.trim() || "paperclipai hub sync",
          lastSyncedAt: new Date().toISOString(),
        };
        try {
          await ctx.api.patch(`/companies/${companyId}/external-source`, { externalSource });
          console.log(pc.green(`[hub sync] externalSource patched`));
        } catch (err) {
          const msg = err instanceof ApiRequestError ? `${err.status} ${err.message}` : String(err);
          console.log(pc.yellow(`[hub sync] externalSource patch failed: ${msg}`));
        }
      }
    } catch (err) {
      handleCommandError(err);
    }
  });
}
