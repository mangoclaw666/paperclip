import { Command } from "commander";
import path from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { LEADERSHIP_TEMPLATE, composeAgentFiles, type AgentRole } from "./agent-templates.js";

/** Folder marker for a Paperclip project package (git-style marker). */
const PROJECT_MARKER = "_paperclip";

interface SyncOptions extends BaseClientOptions {
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

function readTopLevelYamlScalar(text: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

async function ensureCompanyMarkdown(
  paperclipDir: string,
  files: Record<string, unknown>,
  fallbackName: string,
): Promise<{ generated: boolean; companyName: string }> {
  const existing = Object.keys(files).find((k) => k === "COMPANY.md" || k.endsWith("/COMPANY.md"));
  if (existing) {
    const content = files[existing];
    const text = typeof content === "string" ? content : "";
    const meta = parseFrontmatter(text).meta;
    return { generated: false, companyName: String(meta.name ?? fallbackName) };
  }
  let name = fallbackName;
  let description: string | null = null;
  try {
    const yamlText = await readFile(path.join(paperclipDir, ".paperclip.yaml"), "utf-8");
    name = readTopLevelYamlScalar(yamlText, "name") ?? name;
    description = readTopLevelYamlScalar(yamlText, "description");
  } catch { /* no .paperclip.yaml — use fallbacks */ }
  const body = description ? `# ${name}\n\n${description}\n` : `# ${name}\n`;
  const generated = `---\nname: ${name}\nslug: ${name}\n${description ? `description: ${description}\n` : ""}---\n\n${body}`;
  files["COMPANY.md"] = generated;
  return { generated: true, companyName: name };
}

/**
 * Read all *.md files in a folder (sorted by filename) and join them with separators.
 * Returns empty string if folder missing or has no .md files.
 */
async function readSharedMarkdown(dir: string, header: string): Promise<string> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return ""; }
  const mdFiles = entries.filter((n) => n.endsWith(".md")).sort();
  if (mdFiles.length === 0) return "";
  const parts: string[] = [`<!-- ${header} (auto-merged from ${path.basename(dir)}/) -->`];
  for (const fn of mdFiles) {
    const content = await readFile(path.join(dir, fn), "utf-8");
    parts.push(content.trim());
  }
  return parts.join("\n\n");
}

/**
 * Prepend company-common markdown to each agent's AGENTS.md in the files dict.
 * Returns the prepended block (or empty string) for reporting.
 */
async function prependCompanyCommonToAgents(paperclipDir: string, files: Record<string, unknown>): Promise<string> {
  const commonDir = path.join(paperclipDir, "_shared", "company-common");
  const commonText = await readSharedMarkdown(commonDir, "회사 공통 (모든 agent 에 자동 적용)");
  if (!commonText) return "";
  for (const key of Object.keys(files)) {
    if (key === "AGENTS.md" || key.endsWith("/AGENTS.md")) {
      const original = typeof files[key] === "string" ? files[key] as string : "";
      // Insert AFTER frontmatter if present, otherwise at very top
      const fm = original.match(/^---\n[\s\S]*?\n---\n/);
      if (fm) {
        files[key] = fm[0] + "\n" + commonText + "\n\n" + original.slice(fm[0].length);
      } else {
        files[key] = commonText + "\n\n" + original;
      }
    }
  }
  return commonText;
}

/**
 * Find the project root by walking up from `start` looking for a `_paperclip/` folder.
 * Git-style discovery — `_paperclip/` is the marker.
 * Returns the parent of `_paperclip/` (the project root, used as workspace cwd).
 * Also handles being invoked from INSIDE `_paperclip/` itself.
 * Throws if not found.
 */
async function findProjectRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  if (path.basename(current) === PROJECT_MARKER) {
    return path.dirname(current);
  }
  while (true) {
    try {
      const markerStat = await stat(path.join(current, PROJECT_MARKER));
      if (markerStat.isDirectory()) return current;
    } catch { /* not here, walk up */ }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `No ${PROJECT_MARKER}/ folder found in ${start} or any parent directory.\n` +
        `Run this command from a project folder that contains ${PROJECT_MARKER}/ (or pass --path <dir>).`,
      );
    }
    current = parent;
  }
}

/** Normalize a filesystem path for storage: forward slashes, no trailing slash. */
function normalizeStoredPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

async function collectGoals(paperclipDir: string): Promise<GoalEntry[]> {
  const goalsDir = path.join(paperclipDir, "goals");
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

/** Scaffold contents — minimal _paperclip/ tree that `paperclipai sync` can push as-is. */
const PROJECT_SCAFFOLD = {
  ".paperclip.yaml": (name: string) =>
    `name: ${name}\n` +
    `description: ${name} — Paperclip project\n` +
    `schemaVersion: 1\n` +
    `\n` +
    `paths:\n` +
    `  agents: agents/\n` +
    `  goals: goals/\n` +
    `  projects: projects/\n` +
    `  tasks: tasks/\n` +
    `\n` +
    `# Per-agent adapter is set by 'paperclipai sync' at sync time.\n` +
    `# To override the default adapter for an individual agent, add:\n` +
    `#   agents:\n` +
    `#     ceo:\n` +
    `#       adapter:\n` +
    `#         type: claude_local\n`,

  "_shared/company-common/01_language.md":
    `# 회사 공통 규칙\n\n` +
    `## 언어\n` +
    `- 모든 응답·코멘트·로그는 한국어로 작성.\n` +
    `- 코드·기술 식별자만 영어 그대로.\n`,

  // CEO 4 파일은 leadership baseline 을 그대로 사용.
  // 표준 행동 룰 (탐색 금지, 즉시 종료, API 호출 패턴) 모두 박혀 있고,
  // 회사·역할 specific 부분은 [채워 넣기: ...] 자리로 비워둠.
  "agents/ceo/AGENTS.md": LEADERSHIP_TEMPLATE["AGENTS.md"],
  "agents/ceo/HEARTBEAT.md": LEADERSHIP_TEMPLATE["HEARTBEAT.md"],
  "agents/ceo/SOUL.md": LEADERSHIP_TEMPLATE["SOUL.md"],
  "agents/ceo/TOOLS.md": LEADERSHIP_TEMPLATE["TOOLS.md"],

  "goals/example/GOAL.md":
    `---\nslug: example\ntitle: 첫 목표\nlevel: company\nstatus: active\n---\n\n` +
    `# 첫 목표\n\n` +
    `(여기에 회사 단위 목표 한 줄 — projects 들이 이 goal에 묶임)\n`,

  "projects/example/PROJECT.md":
    `---\nslug: example\nname: 첫 프로젝트\ngoalSlug: example\nstatus: in_progress\nleadAgentSlug: ceo\n---\n\n` +
    `# 첫 프로젝트\n\n` +
    `## 산출물\n- (이 프로젝트가 만들어 낼 것들)\n\n` +
    `## 워크스페이스\n- (작업 폴더 또는 외부 repo 위치)\n`,

  "tasks/task-001/TASK.md":
    `---\nslug: task-001\ntitle: 첫 task\nkind: task\nproject: example\nassignee: ceo\nstatus: todo\npriority: medium\n---\n\n` +
    `# Task 001 — 첫 task\n\n` +
    `## 무엇\n- (구체적 작업)\n\n` +
    `## 검수 기준\n- (완료 판단 기준)\n`,

  "knowledge/product-spec.md": (name: string) =>
    `# ${name} — Product Spec\n\n` +
    `## 한 줄\n(여기에 제품 한 줄 정의)\n\n` +
    `## 컨셉\n` +
    `## 타깃\n` +
    `## 톤\n`,

  "README.md": (name: string) =>
    `# ${name}\n\n` +
    `Paperclip project — scaffolded by \`paperclipai init\`.\n\n` +
    `## 셋업\n\n` +
    `\`\`\`bash\n` +
    `# 1) Paperclip 인스턴스 띄움 (별도 셋업)\n` +
    `# 2) 이 폴더에서:\n` +
    `paperclipai sync\n` +
    `\`\`\`\n\n` +
    `## 구조\n\n` +
    `\`\`\`\n` +
    `${name}/\n` +
    `├─ _paperclip/            PaperClip 에 sync 할 portable 패키지\n` +
    `│  ├─ .paperclip.yaml\n` +
    `│  ├─ _shared/           회사 공통 규칙 + agent 공통 prompt 부분\n` +
    `│  ├─ agents/            agent 별 markdown\n` +
    `│  ├─ goals/             company-level 목표\n` +
    `│  ├─ projects/          작업 묶음\n` +
    `│  └─ tasks/             개별 task\n` +
    `├─ knowledge/            컨셉·톤·spec\n` +
    `└─ app/                  agent 산출물이 들어갈 자리 (필요시)\n` +
    `\`\`\`\n`,
};

async function writeScaffold(root: string, name: string): Promise<string[]> {
  const written: string[] = [];
  for (const [relPath, value] of Object.entries(PROJECT_SCAFFOLD)) {
    // README.md and knowledge/ live at project root; everything else under _paperclip/
    const target = relPath === "README.md" || relPath.startsWith("knowledge/")
      ? path.join(root, relPath)
      : path.join(root, PROJECT_MARKER, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    const content = typeof value === "function" ? value(name) : value;
    await writeFile(target, content, "utf-8");
    written.push(path.relative(root, target).replace(/\\/g, "/"));
  }
  return written.sort();
}

export function registerProjectCommands(program: Command): void {
  program
    .command("init")
    .description(`Scaffold a new ${PROJECT_MARKER}/ project in the current directory (or --dir <path>)`)
    .option("--name <name>", "Project name (defaults to folder name)")
    .option("--dir <dir>", "Target directory (defaults to current working directory)")
    .option("--force", "Overwrite existing files (default: error if any scaffold path exists)", false)
    .action(async (opts: { name?: string; dir?: string; force?: boolean }) => {
      try {
        const root = path.resolve(opts.dir?.trim() || process.cwd());
        const name = opts.name?.trim() || path.basename(root);
        // Pre-flight: refuse to overwrite unless --force
        if (!opts.force) {
          try {
            const existing = await stat(path.join(root, PROJECT_MARKER));
            if (existing.isDirectory()) {
              throw new Error(`${PROJECT_MARKER}/ already exists at ${root}. Pass --force to overwrite.`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith(`${PROJECT_MARKER}/`)) throw err;
            // ENOENT means we're good
          }
        }
        await mkdir(root, { recursive: true });
        console.log(pc.cyan(`[init] scaffolding "${name}" at ${root}`));
        const written = await writeScaffold(root, name);
        for (const p of written) console.log(pc.dim(`  + ${p}`));
        console.log("");
        console.log(pc.green(`✓ Done. Next:`));
        console.log(`  1. Edit ${pc.cyan(PROJECT_MARKER + "/agents/ceo/")} and add more agents under ${pc.cyan(PROJECT_MARKER + "/agents/")}`);
        console.log(`  2. Add goals/projects/tasks under ${pc.cyan(PROJECT_MARKER + "/goals,projects,tasks/")}`);
        console.log(`  3. Run: ${pc.cyan("paperclipai sync")}`);
      } catch (err) {
        handleCommandError(err);
      }
    });

  addCommonClientOptions(
    program
      .command("sync")
      .description(`Walk ./${PROJECT_MARKER}/ (or --path) and push agents + projects + tasks + goals to Paperclip`)
      .option("--path <dir>", `Project root containing ${PROJECT_MARKER}/ (defaults to current working directory)`)
      .option("--collision <mode>", "Collision strategy: rename | skip | replace", "replace")
      .option("--new-company-name <name>", "Name override when creating a new company")
      .option("--skip-goals", `Don't POST goals from ${PROJECT_MARKER}/goals/`, false)
      .option("--skip-external-source", "Don't PATCH externalSource after import", false)
      .option("--sync-command <cmd>", "Command stored on externalSource for the dashboard 'Re-sync' button")
      .option("--workspace-path <dir>", "workspacePath stored on externalSource (defaults to project root)"),
    { includeCompany: true },
  ).action(async (opts: SyncOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      // Auto-detect project root by finding _paperclip/ starting from --path or cwd
      // and walking up the directory tree (git-style marker discovery).
      const startDir = opts.path?.trim() || process.cwd();
      const projectRoot = await findProjectRoot(startDir);
      const paperclipDir = path.join(projectRoot, PROJECT_MARKER);
      const normalizedProjectRoot = normalizeStoredPath(projectRoot);
      const normalizedPaperclipDir = normalizeStoredPath(paperclipDir);
      console.log(pc.dim(`[sync] project root: ${normalizedProjectRoot}`));

      const inline = await resolveInlineSourceFromPath(paperclipDir);
      const filesDict = inline.files as Record<string, unknown>;
      const ensured = await ensureCompanyMarkdown(paperclipDir, filesDict, path.basename(projectRoot));
      if (ensured.generated) {
        console.log(pc.dim(`[sync] generated COMPANY.md from .paperclip.yaml (name=${ensured.companyName})`));
      }
      const commonPrepended = await prependCompanyCommonToAgents(paperclipDir, filesDict);
      if (commonPrepended) {
        console.log(pc.dim(`[sync] prepended _shared/company-common/ to every AGENTS.md (${commonPrepended.length} chars)`));
      }
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

      console.log(pc.cyan(`[sync] importing from ${paperclipDir}`));
      const result = await ctx.api.post<CompanyPortabilityImportResult>(applyPath, {
        source: { type: "inline", rootPath: path.basename(projectRoot), files: inline.files },
        target,
        agents: "all",
        collisionStrategy: collision,
        include: { company: true, agents: true, projects: true, issues: true, skills: true },
      });
      if (!result) throw new Error("Import returned no result.");
      const companyId = result.company.id;
      console.log(pc.green(`[sync] company ${companyId} (${result.company.action})`));
      const projectsCount = result.projects?.length ?? 0;
      const issuesCount = (result as { issues?: unknown[] }).issues?.length ?? 0;
      console.log(`  agents=${result.agents.length} projects=${projectsCount} issues=${issuesCount} warnings=${result.warnings.length}`);

      // For each agent: set adapterConfig.cwd (so heartbeats land in the project),
      // push every _paperclip/agents/<slug>/*.md as a managed instructions file (real
      // files in instructions/, not the deprecated promptTemplate string field),
      // and clear any legacy promptTemplate/bootstrapPromptTemplate left over
      // from prior syncs so the "Deprecated virtual file" disappears.
      const agentCwd = normalizedProjectRoot;
      console.log(pc.cyan(`[sync] patching ${result.agents.length} agent(s) — cwd=${agentCwd}, managed instructions, clearing legacy prompt template`));
      for (const a of result.agents) {
        if (!a.id) continue;
        try {
          const current = await ctx.api.get<{ adapterConfig?: Record<string, unknown> }>(`/api/agents/${a.id}`);
          const nextAdapterConfig: Record<string, unknown> = {
            ...(current?.adapterConfig ?? {}),
            cwd: agentCwd,
          };
          // Strip deprecated fields if they remain from prior syncs.
          delete nextAdapterConfig.promptTemplate;
          delete nextAdapterConfig.bootstrapPromptTemplate;
          await ctx.api.patch(`/api/agents/${a.id}`, { adapterConfig: nextAdapterConfig });

          // Push each markdown file from _paperclip/agents/<slug>/ as a managed
          // instructions file. Idempotent: same content is a no-op upstream.
          // We use the already-mutated `filesDict` so company-common is
          // prepended to AGENTS.md exactly as it was for the import bundle.
          const agentPrefix = `agents/${a.slug}/`;
          const agentFiles = Object.keys(filesDict).filter(
            (k) => k.startsWith(agentPrefix) && k.toLowerCase().endsWith(".md"),
          );
          let pushedFiles = 0;
          for (const key of agentFiles) {
            const raw = filesDict[key];
            const content = typeof raw === "string" ? raw : "";
            if (!content) continue;
            const relativePath = key.slice(agentPrefix.length); // e.g. "AGENTS.md"
            await ctx.api.put(`/api/agents/${a.id}/instructions-bundle/file`, {
              path: relativePath,
              content,
              clearLegacyPromptTemplate: true,
            });
            pushedFiles++;
          }
          console.log(`  ${a.slug}: cwd + ${pushedFiles} instructions file(s)`);
        } catch (err) {
          const msg = err instanceof ApiRequestError ? `${err.status} ${err.message}` : String(err);
          console.log(pc.yellow(`  ${a.slug}: ${msg}`));
        }
      }

      if (!opts.skipGoals) {
        const goals = await collectGoals(paperclipDir);
        if (goals.length > 0) {
          console.log(pc.cyan(`[sync] posting ${goals.length} goal(s)`));
          for (const g of goals) {
            try {
              await ctx.api.post(`/api/companies/${companyId}/goals`, {
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
          rootPath: normalizedPaperclipDir,
          workspacePath: opts.workspacePath?.trim() ? normalizeStoredPath(opts.workspacePath.trim()) : normalizedProjectRoot,
          syncCommand: opts.syncCommand?.trim() || "paperclipai sync",
          lastSyncedAt: new Date().toISOString(),
        };
        try {
          await ctx.api.patch(`/api/companies/${companyId}/external-source`, { externalSource });
          console.log(pc.green(`[sync] externalSource patched`));
        } catch (err) {
          const msg = err instanceof ApiRequestError ? `${err.status} ${err.message}` : String(err);
          console.log(pc.yellow(`[sync] externalSource patch failed: ${msg}`));
        }
      }
    } catch (err) {
      handleCommandError(err);
    }
  });

  // add-agent: scaffold a new agent folder under _paperclip/agents/<slug>/
  // with 4 baseline files (AGENTS / HEARTBEAT / SOUL / TOOLS). Does NOT call
  // the server — `paperclipai sync` picks up the new folder on the next run.
  program
    .command("add-agent <slug>")
    .description("Scaffold a new agent under _paperclip/agents/<slug>/ from the role baseline")
    .option("--role <role>", "Agent role baseline: leadership | default", "default")
    .option("--name <name>", "Display name (defaults to slug)")
    .option("--reports-to <slug>", "Manager agent slug (default role only; defaults to ceo)")
    .option("--dir <dir>", "Project root (defaults to walk-up from cwd)")
    .option("--force", "Overwrite existing agent folder", false)
    .action(async (slug: string, opts: { role?: string; name?: string; reportsTo?: string; dir?: string; force?: boolean }) => {
      try {
        const role = (opts.role ?? "default").toLowerCase() as AgentRole;
        if (role !== "leadership" && role !== "default") {
          throw new Error(`--role must be 'leadership' or 'default', got '${opts.role}'`);
        }
        const cleanSlug = slug.trim().toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(cleanSlug)) {
          throw new Error(`slug must be lowercase letters/digits/hyphens, starting with a letter: '${slug}'`);
        }
        const startDir = opts.dir?.trim() || process.cwd();
        const projectRoot = await findProjectRoot(startDir);
        const agentDir = path.join(projectRoot, PROJECT_MARKER, "agents", cleanSlug);

        // Pre-flight: refuse to overwrite unless --force
        if (!opts.force) {
          try {
            const existing = await stat(agentDir);
            if (existing.isDirectory()) {
              throw new Error(`agents/${cleanSlug}/ already exists. Pass --force to overwrite, or pick a different slug.`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("agents/")) throw err;
            // ENOENT means good
          }
        }

        const files = composeAgentFiles(role, cleanSlug, opts.name, opts.reportsTo ?? "ceo");
        await mkdir(agentDir, { recursive: true });
        const written: string[] = [];
        for (const [name, content] of Object.entries(files)) {
          const target = path.join(agentDir, name);
          await writeFile(target, content, "utf-8");
          written.push(path.relative(projectRoot, target).replace(/\\/g, "/"));
        }

        console.log(pc.cyan(`[add-agent] ${role} agent "${cleanSlug}" scaffolded at ${agentDir}`));
        for (const p of written) console.log(pc.dim(`  + ${p}`));
        console.log("");
        console.log(pc.green("✓ Done. Next:"));
        console.log(`  1. Edit ${pc.cyan(`${PROJECT_MARKER}/agents/${cleanSlug}/AGENTS.md`)} — fill in [채워 넣기: ...] placeholders (회사명, 직무, 산출물 폴더)`);
        console.log(`  2. Edit ${pc.cyan(`${PROJECT_MARKER}/agents/${cleanSlug}/SOUL.md`)} — fill in 페르소나·가치관`);
        console.log(`  3. Edit ${pc.cyan(`${PROJECT_MARKER}/agents/${cleanSlug}/TOOLS.md`)} — adjust 도구 정책 (산출물 폴더, 외부 의존성 정책)`);
        console.log(`  4. Run ${pc.cyan("paperclipai sync")} to push to PaperClip`);
      } catch (err) {
        handleCommandError(err);
      }
    });
}
