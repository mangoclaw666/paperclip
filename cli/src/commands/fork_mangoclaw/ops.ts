// fork_mangoclaw: top-level CLI commands (init / sync / add-agent).
// Not part of upstream PaperClip. Hosts the slug-based upsert sync logic
// and the 4-file baseline template scaffolder. See fork_mangoclaw/README.md.
import { Command } from "commander";
import path from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import pc from "picocolors";
import type {
  CompanyPortabilityImportResult,
  CompanyExternalSource,
} from "@paperclipai/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "../client/common.js";
import {
  resolveCompanyImportApiPath,
  resolveInlineSourceFromPath,
} from "../client/company.js";
import { LEADERSHIP_TEMPLATE, composeAgentFiles, type AgentRole } from "./agent-templates.js";

/**
 * Folder markers for a Paperclip project package (git-style markers).
 * The first one is the PaperClip standard and the one `init` writes to.
 * Later entries are aliases that `sync` / `add-agent` also accept — useful
 * when a user prefers a different folder name for their projects but still
 * wants this CLI to find the package automatically. To register a private
 * alias, append it here (e.g. `"_ops"`).
 */
const PROJECT_MARKERS = ["_paperclip", "_ops"] as const;
const PROJECT_MARKER = PROJECT_MARKERS[0]; // canonical name `init` writes

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
  parentGoalSlug: string | null;
  bodyText: string;
}

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  // Normalize CRLF → LF so files saved on Windows with `\r\n` line endings
  // parse identically to LF files. Without this, the regex below matches `\n`
  // but the file has `\r\n`, the whole frontmatter block fails to extract,
  // and downstream `meta.name` falls through to the slug — producing dup
  // entities on every sync (title mismatch from "raw slug" vs "real name").
  const normalized = text.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: normalized };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trim() };
}

/**
 * fork_mangoclaw: write a single scalar field into a markdown file's YAML
 * frontmatter, preserving everything else. Used after each `sync` upsert to
 * stamp the server-assigned `identifier:` (e.g. `MK-01`, `001`, `MAK-005`)
 * back onto the local file so the folder is self-describing and `grep` finds
 * the human ID without round-tripping through the API.
 *
 * Idempotent: returns false (no write) when the field already equals the new
 * value. Returns false if the file has no `---` frontmatter block — we don't
 * try to invent one because it might break other tools' expectations.
 */
async function setFrontmatterField(
  filePath: string,
  key: string,
  value: string | number | null | undefined,
): Promise<boolean> {
  let text: string;
  try { text = await readFile(filePath, "utf-8"); } catch { return false; }
  const normalized = text.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return false;
  const lines = fmMatch[1].split("\n");
  const body = fmMatch[2];
  const valueStr = value === null || value === undefined ? "" : String(value);
  const keyRe = new RegExp(`^${key}\\s*:`);
  const foundIdx = lines.findIndex((line) => keyRe.test(line));
  if (foundIdx >= 0) {
    const existing = lines[foundIdx].replace(keyRe, "").trim().replace(/^["']|["']$/g, "");
    if (existing === valueStr) return false;
    if (valueStr === "") {
      lines.splice(foundIdx, 1);
    } else {
      lines[foundIdx] = `${key}: ${valueStr}`;
    }
  } else if (valueStr !== "") {
    lines.push(`${key}: ${valueStr}`);
  } else {
    return false;
  }
  const newText = `---\n${lines.join("\n")}\n---\n\n${body}`;
  await writeFile(filePath, newText, "utf-8");
  return true;
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
 * Find the project root + which marker it uses by walking up from `start`.
 * Git-style discovery against PROJECT_MARKERS (canonical first, aliases after).
 * Returns the parent dir and the marker name that matched. Also handles being
 * invoked from INSIDE one of the marker folders. Throws if none found.
 */
async function findProjectRoot(start: string): Promise<{ root: string; marker: string }> {
  let current = path.resolve(start);
  const basename = path.basename(current);
  for (const marker of PROJECT_MARKERS) {
    if (basename === marker) return { root: path.dirname(current), marker };
  }
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      try {
        const markerStat = await stat(path.join(current, marker));
        if (markerStat.isDirectory()) return { root: current, marker };
      } catch { /* try next marker */ }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      const markerList = PROJECT_MARKERS.map((m) => `${m}/`).join(" or ");
      throw new Error(
        `No ${markerList} folder found in ${start} or any parent directory.\n` +
        `Run this command from a project folder that contains one of those (or pass --path <dir>).`,
      );
    }
    current = parent;
  }
}

/** Normalize a filesystem path for storage: forward slashes, no trailing slash. */
function normalizeStoredPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Identity marker embedded in entity description so we can find the entity
 * again on the next sync by its source slug (PaperClip itself has no slug
 * column on goals/projects/issues — we own this convention).
 *
 * The marker is hidden inside an HTML comment so it doesn't show up in any
 * rendered description view. Compatible with the older `sync_portable.py`
 * convention (`<!-- make-meta: slug=mk-001 | type=project -->`).
 */
const SLUG_MARKER_RE = /<!--\s*fork_mangoclaw:\s*slug=([\w-]+)(?:\s*\|\s*type=(\w+))?\s*-->|<!--\s*make-meta:\s*slug=([\w-]+)(?:\s*\|\s*type=(\w+))?\s*-->/;

function extractSlugFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const m = description.match(SLUG_MARKER_RE);
  if (!m) return null;
  return m[1] || m[3] || null;
}

function buildDescriptionWithMarker(slug: string, kind: "goal" | "project" | "issue", body: string): string {
  return `<!-- fork_mangoclaw: slug=${slug} | type=${kind} -->\n\n${body || ""}`.trimEnd();
}

/**
 * Strip surrounding quotes that a YAML parser may have preserved in the title
 * (`'MK-014 T5: …'` or `"…"`). Keeps idempotency robust against the YAML
 * round-trip that broke our earlier sync.
 */
function cleanTitle(raw: string): string {
  let t = (raw || "").trim();
  // Strip outer quotes iteratively — covers nested forms like `'"title"'`
  // produced when YAML uses single quotes to wrap a string containing
  // double quotes (e.g. `name: '"오늘의 프로젝트" 로직'`).
  for (let i = 0; i < 3; i++) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return t.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
}

interface ProjectSpec {
  slug: string;
  name: string;
  description: string;
  status: string;
  goalSlug: string | null;
  assigneeAgentSlug: string | null;
  bodyText: string;
}

interface TaskSpec {
  slug: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  projectSlug: string | null;
  goalSlug: string | null;
  assigneeAgentSlug: string | null;
  bodyText: string;
}

/**
 * Project status enum normalization. PaperClip accepts
 * `backlog / planned / in_progress / completed / cancelled` only; markdown
 * in the wild often uses issue-style values (`done`, `todo`, `blocked`) from
 * older migrations.
 */
function normalizeProjectStatus(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (["backlog", "planned", "in_progress", "completed", "cancelled"].includes(s)) return s;
  if (s === "done" || s === "achieved") return "completed";
  if (s === "todo") return "backlog";
  if (s === "blocked" || s === "active") return "in_progress";
  return "planned";
}

async function collectProjects(paperclipDir: string): Promise<ProjectSpec[]> {
  const dir = path.join(paperclipDir, "projects");
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const out: ProjectSpec[] = [];
  for (const slug of entries) {
    const file = path.join(dir, slug, "PROJECT.md");
    try {
      const stats = await stat(file);
      if (!stats.isFile()) continue;
    } catch { continue; }
    const text = await readFile(file, "utf-8");
    const { meta, body } = parseFrontmatter(text);
    out.push({
      slug,
      name: cleanTitle(String(meta.name ?? slug)),
      description: body || "",
      status: normalizeProjectStatus(meta.status as string | undefined),
      goalSlug: (meta.goal_slug && String(meta.goal_slug).trim()) ? String(meta.goal_slug) : null,
      assigneeAgentSlug: (meta.assignee_agent_slug && String(meta.assignee_agent_slug).trim()) ? String(meta.assignee_agent_slug) : null,
      bodyText: body,
    });
  }
  return out;
}

async function collectTasks(paperclipDir: string): Promise<TaskSpec[]> {
  const dir = path.join(paperclipDir, "tasks");
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const out: TaskSpec[] = [];
  for (const slug of entries) {
    const file = path.join(dir, slug, "TASK.md");
    try {
      const stats = await stat(file);
      if (!stats.isFile()) continue;
    } catch { continue; }
    const text = await readFile(file, "utf-8");
    const { meta, body } = parseFrontmatter(text);
    out.push({
      slug,
      title: cleanTitle(String(meta.name ?? meta.title ?? slug)),
      description: body || "",
      status: String(meta.status ?? "todo"),
      priority: String(meta.priority ?? "medium"),
      projectSlug: (meta.project_slug && String(meta.project_slug).trim()) ? String(meta.project_slug) : null,
      goalSlug: (meta.goal_slug && String(meta.goal_slug).trim()) ? String(meta.goal_slug) : null,
      assigneeAgentSlug: (meta.assignee_agent_slug && String(meta.assignee_agent_slug).trim()) ? String(meta.assignee_agent_slug) : null,
      bodyText: body,
    });
  }
  return out;
}

interface DbEntity {
  id: string;
  title?: string;
  name?: string;
  description?: string | null;
  // fork_mangoclaw: server-assigned human ID (e.g. MK-01, 001, MAK-005).
  identifier?: string | null;
}

/**
 * Find an existing entity (goal / project / issue) by its embedded slug
 * marker, falling back to title equality. Used to keep `sync` idempotent.
 */
function findBySlugOrTitle<T extends DbEntity>(rows: T[], slug: string, expectedTitle: string): T | undefined {
  // Prefer slug marker match (most precise; resilient to title edits)
  for (const r of rows) {
    if (extractSlugFromDescription(r.description) === slug) return r;
  }
  // Fall back to title equality (normalized)
  const want = cleanTitle(expectedTitle);
  for (const r of rows) {
    const candidate = cleanTitle(r.title ?? r.name ?? "");
    if (candidate === want) return r;
  }
  return undefined;
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
    const title = cleanTitle(String(meta.name ?? meta.title ?? firstHeading ?? slug));
    out.push({
      slug,
      title,
      description: body || null,
      level: (String(meta.level ?? "company")) as GoalEntry["level"],
      status,
      parentGoalSlug: (meta.parent_goal_slug && String(meta.parent_goal_slug) !== "null" && String(meta.parent_goal_slug).trim()) ? String(meta.parent_goal_slug) : null,
      bodyText: body,
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
      const startDir = opts.path?.trim() || process.cwd();
      const { root: projectRoot, marker: detectedMarker } = await findProjectRoot(startDir);
      const paperclipDir = path.join(projectRoot, detectedMarker);
      const normalizedProjectRoot = normalizeStoredPath(paperclipDir);
      const normalizedPaperclipDir = normalizeStoredPath(paperclipDir);
      const normalizedWorkspace = normalizeStoredPath(projectRoot);
      console.log(pc.dim(`[sync] project root: ${normalizedWorkspace} (marker: ${detectedMarker}/)`));

      // ── Prepare the in-memory file bundle (same prep regardless of branch).
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

      // ── Branch on company existence. importBundle creates duplicates when
      // re-run, so we only call it for the genuine first import. Everything
      // else goes through slug-based upsert.
      const explicitCompanyId = opts.companyId?.trim() || ctx.companyId;
      let companyId: string = "";
      let isFirstImport = false;

      if (explicitCompanyId) {
        // User passed --company-id: trust them, run upsert against it.
        companyId = explicitCompanyId;
      } else {
        // Look the company up by name. Try multiple candidates because the
        // YAML manifest name and the on-disk folder name often differ
        // (e.g. yaml "coffee-lab" vs DB "51_coffee-lab" created from path).
        const allCompanies = await ctx.api.get<Array<{ id: string; name: string }>>(`/api/companies`) ?? [];
        const candidates = [
          opts.newCompanyName?.trim(),
          ensured.companyName?.trim(),
          path.basename(projectRoot).trim(),
        ].filter((c): c is string => !!c);
        const existing = candidates.map((wantName) => allCompanies.find((c) => c.name === wantName)).find((c) => c);
        if (existing) {
          companyId = existing.id;
          console.log(pc.dim(`[sync] found existing company "${existing.name}" (${companyId}) — upserting`));
        } else {
          console.log(pc.dim(`[sync] no existing company matched candidates [${candidates.join(", ")}] — will import`));
          isFirstImport = true;
        }
      }

      if (isFirstImport) {
        // Genuine first sync: hand off to portability importBundle. After this,
        // future syncs will hit the upsert branch automatically.
        const applyPath = resolveCompanyImportApiPath({ dryRun: false, targetMode: "new_company", companyId: null });
        console.log(pc.cyan(`[sync] first import — creating new company via importBundle`));
        const result = await ctx.api.post<CompanyPortabilityImportResult>(applyPath, {
          source: { type: "inline", rootPath: path.basename(projectRoot), files: inline.files },
          target: { mode: "new_company", newCompanyName: opts.newCompanyName?.trim() || ensured.companyName || path.basename(projectRoot) },
          agents: "all",
          collisionStrategy: "rename",
          include: { company: true, agents: true, projects: true, issues: true, skills: true },
        });
        if (!result) throw new Error("Import returned no result.");
        companyId = result.company.id;
        console.log(pc.green(`[sync] company ${companyId} (${result.company.action})`));
        const projectsCount = result.projects?.length ?? 0;
        const issuesCount = (result as { issues?: unknown[] }).issues?.length ?? 0;
        console.log(`  agents=${result.agents.length} projects=${projectsCount} issues=${issuesCount} warnings=${result.warnings.length}`);
      }

      // From here on the upsert path runs for both branches — first imports
      // also benefit (e.g. instructions PUT, externalSource PATCH).
      if (!companyId) throw new Error("companyId resolution failed (neither --company-id nor first import set it)");
      const goalSlugToId = new Map<string, string>();
      const projectSlugToId = new Map<string, string>();
      const agentSlugToId = new Map<string, string>();

      // ── Goals: process in level order (company → team → agent → task) so
      // parents exist before children.
      const goalSpecs = await collectGoals(paperclipDir);
      if (goalSpecs.length > 0) {
        console.log(pc.cyan(`[sync] goals upsert (${goalSpecs.length})`));
        const dbGoals = await ctx.api.get<DbEntity[]>(`/api/companies/${companyId}/goals`) ?? [];
        const levelOrder: Record<string, number> = { company: 0, team: 1, agent: 2, task: 3 };
        const sorted = [...goalSpecs].sort((a, b) => (levelOrder[a.level] ?? 99) - (levelOrder[b.level] ?? 99));
        let created = 0, updated = 0, failed = 0, stamped = 0;
        for (const g of sorted) {
          const parentId = g.parentGoalSlug ? goalSlugToId.get(g.parentGoalSlug) ?? null : null;
          if (g.parentGoalSlug && !parentId) {
            console.log(pc.yellow(`  ${g.slug}: parent ${g.parentGoalSlug} not yet known — skipping`));
            failed++; continue;
          }
          const body = { title: g.title, level: g.level, status: g.status, parentId, description: buildDescriptionWithMarker(g.slug, "goal", g.bodyText) };
          try {
            const existing = findBySlugOrTitle(dbGoals, g.slug, g.title);
            let identifier: string | null | undefined = null;
            if (existing) {
              const patched = await ctx.api.patch<DbEntity>(`/api/goals/${existing.id}`, body);
              goalSlugToId.set(g.slug, existing.id);
              identifier = patched?.identifier ?? existing.identifier;
              updated++;
            } else {
              const created2 = await ctx.api.post<DbEntity>(`/api/companies/${companyId}/goals`, body);
              if (created2?.id) {
                goalSlugToId.set(g.slug, created2.id);
                identifier = created2.identifier;
                created++;
              }
            }
            // fork_mangoclaw: stamp server-assigned identifier into local GOAL.md frontmatter.
            if (identifier) {
              const goalFile = path.join(paperclipDir, "goals", g.slug, "GOAL.md");
              if (await setFrontmatterField(goalFile, "identifier", identifier)) stamped++;
            }
          } catch (err) {
            const msg = err instanceof ApiRequestError ? `${(err as ApiRequestError).status} ${(err as ApiRequestError).message}` : String(err);
            console.log(pc.yellow(`  ${g.slug}: ${msg}`));
            failed++;
          }
        }
        console.log(`  goals: created=${created} updated=${updated} failed=${failed} identifier-stamped=${stamped}`);
      }

      // ── Projects
      const projectSpecs = await collectProjects(paperclipDir);
      if (projectSpecs.length > 0) {
        console.log(pc.cyan(`[sync] projects upsert (${projectSpecs.length})`));
        const dbProjects = await ctx.api.get<DbEntity[]>(`/api/companies/${companyId}/projects`) ?? [];
        let created = 0, updated = 0, failed = 0, stamped = 0;
        for (const p of projectSpecs) {
          const goalId = p.goalSlug ? goalSlugToId.get(p.goalSlug) ?? null : null;
          const body: Record<string, unknown> = { name: p.name, status: p.status, description: buildDescriptionWithMarker(p.slug, "project", p.bodyText) };
          if (goalId) body.goalId = goalId;
          try {
            const existing = findBySlugOrTitle(dbProjects, p.slug, p.name);
            let identifier: string | null | undefined = null;
            if (existing) {
              const patched = await ctx.api.patch<DbEntity>(`/api/projects/${existing.id}`, body);
              projectSlugToId.set(p.slug, existing.id);
              identifier = patched?.identifier ?? existing.identifier;
              updated++;
            } else {
              const created2 = await ctx.api.post<DbEntity>(`/api/companies/${companyId}/projects`, body);
              if (created2?.id) {
                projectSlugToId.set(p.slug, created2.id);
                identifier = created2.identifier;
                created++;
              }
            }
            // fork_mangoclaw: stamp identifier into local PROJECT.md frontmatter.
            if (identifier) {
              const projectFile = path.join(paperclipDir, "projects", p.slug, "PROJECT.md");
              if (await setFrontmatterField(projectFile, "identifier", identifier)) stamped++;
            }
          } catch (err) {
            const msg = err instanceof ApiRequestError ? `${(err as ApiRequestError).status} ${(err as ApiRequestError).message}` : String(err);
            console.log(pc.yellow(`  ${p.slug}: ${msg}`));
            failed++;
          }
        }
        console.log(`  projects: created=${created} updated=${updated} failed=${failed} identifier-stamped=${stamped}`);
      }

      // ── Agents: PATCH cwd + managed instructions (slug-based, already idempotent).
      // We also pre-list to build agentSlugToId for issue assignment below.
      const dbAgentsRaw = await ctx.api.get<Array<{ id: string; slug?: string | null; name?: string | null; adapterConfig?: Record<string, unknown> | null }>>(`/api/companies/${companyId}/agents`) ?? [];
      // Build slug → id map. Agents may have null slug; fall back to name lowercase first word.
      for (const a of dbAgentsRaw) {
        const inferredSlug = a.slug ?? (a.name ? a.name.trim().split(/\s+/).pop()?.toLowerCase() ?? null : null);
        if (inferredSlug) agentSlugToId.set(inferredSlug, a.id);
      }
      const agentCwd = normalizedWorkspace;
      console.log(pc.cyan(`[sync] patching ${dbAgentsRaw.length} agent(s) — cwd + managed instructions + clear legacy prompt template`));
      for (const a of dbAgentsRaw) {
        const inferredSlug = a.slug ?? (a.name ? a.name.trim().split(/\s+/).pop()?.toLowerCase() ?? "" : "");
        if (!inferredSlug) continue;
        try {
          const nextAdapterConfig: Record<string, unknown> = { ...(a.adapterConfig ?? {}), cwd: agentCwd };
          delete nextAdapterConfig.promptTemplate;
          delete nextAdapterConfig.bootstrapPromptTemplate;
          await ctx.api.patch(`/api/agents/${a.id}`, { adapterConfig: nextAdapterConfig });

          const agentPrefix = `agents/${inferredSlug}/`;
          const agentFiles = Object.keys(filesDict).filter((k) => k.startsWith(agentPrefix) && k.toLowerCase().endsWith(".md"));
          let pushedFiles = 0;
          for (const key of agentFiles) {
            const raw = filesDict[key];
            const content = typeof raw === "string" ? raw : "";
            if (!content) continue;
            const relativePath = key.slice(agentPrefix.length);
            await ctx.api.put(`/api/agents/${a.id}/instructions-bundle/file`, { path: relativePath, content, clearLegacyPromptTemplate: true });
            pushedFiles++;
          }
          console.log(`  ${inferredSlug}: cwd + ${pushedFiles} instructions file(s)`);
        } catch (err) {
          const msg = err instanceof ApiRequestError ? `${(err as ApiRequestError).status} ${(err as ApiRequestError).message}` : String(err);
          console.log(pc.yellow(`  ${inferredSlug}: ${msg}`));
        }
      }

      // ── Issues (tasks): upsert with project/goal/assignee resolution.
      const taskSpecs = await collectTasks(paperclipDir);
      if (taskSpecs.length > 0) {
        console.log(pc.cyan(`[sync] issues upsert (${taskSpecs.length})`));
        const dbIssues = await ctx.api.get<DbEntity[]>(`/api/companies/${companyId}/issues?status=todo,in_progress,blocked,in_review,done,cancelled,backlog`) ?? [];
        let created = 0, updated = 0, failed = 0, stamped = 0;
        for (const t of taskSpecs) {
          const projectId = t.projectSlug ? projectSlugToId.get(t.projectSlug) ?? null : null;
          const goalId = t.goalSlug ? goalSlugToId.get(t.goalSlug) ?? null : null;
          const assigneeAgentId = t.assigneeAgentSlug ? agentSlugToId.get(t.assigneeAgentSlug) ?? null : null;
          const body: Record<string, unknown> = {
            title: t.title,
            status: t.status,
            priority: t.priority,
            description: buildDescriptionWithMarker(t.slug, "issue", t.bodyText),
          };
          if (projectId) body.projectId = projectId;
          if (goalId) body.goalId = goalId;
          if (assigneeAgentId) body.assigneeAgentId = assigneeAgentId;
          try {
            const existing = findBySlugOrTitle(dbIssues, t.slug, t.title);
            let identifier: string | null | undefined = null;
            if (existing) {
              const patched = await ctx.api.patch<DbEntity>(`/api/issues/${existing.id}`, body);
              identifier = patched?.identifier ?? existing.identifier;
              updated++;
            } else {
              const created2 = await ctx.api.post<DbEntity>(`/api/companies/${companyId}/issues`, body);
              identifier = created2?.identifier;
              created++;
            }
            // fork_mangoclaw: stamp issue identifier (MAK-NNN) into local TASK.md frontmatter.
            if (identifier) {
              const taskFile = path.join(paperclipDir, "tasks", t.slug, "TASK.md");
              if (await setFrontmatterField(taskFile, "identifier", identifier)) stamped++;
            }
          } catch (err) {
            const msg = err instanceof ApiRequestError ? `${(err as ApiRequestError).status} ${(err as ApiRequestError).message}` : String(err);
            console.log(pc.yellow(`  ${t.slug}: ${msg}`));
            failed++;
          }
        }
        console.log(`  issues: created=${created} updated=${updated} failed=${failed} identifier-stamped=${stamped}`);
      }

      // ── externalSource PATCH (idempotent — same payload every time).
      if (!opts.skipExternalSource) {
        const externalSource: CompanyExternalSource = {
          type: "filesystem",
          rootPath: normalizedPaperclipDir,
          workspacePath: opts.workspacePath?.trim() ? normalizeStoredPath(opts.workspacePath.trim()) : normalizedWorkspace,
          syncCommand: opts.syncCommand?.trim() || "paperclipai sync",
          lastSyncedAt: new Date().toISOString(),
        };
        try {
          await ctx.api.patch(`/api/companies/${companyId}/external-source`, { externalSource });
          console.log(pc.green(`[sync] externalSource patched`));
        } catch (err) {
          const msg = err instanceof ApiRequestError ? `${(err as ApiRequestError).status} ${(err as ApiRequestError).message}` : String(err);
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
        const { root: projectRoot, marker: detectedMarker } = await findProjectRoot(startDir);
        const agentDir = path.join(projectRoot, detectedMarker, "agents", cleanSlug);

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
        console.log(`  1. Edit ${pc.cyan(`${detectedMarker}/agents/${cleanSlug}/AGENTS.md`)} — fill in [채워 넣기: ...] placeholders (회사명, 직무, 산출물 폴더)`);
        console.log(`  2. Edit ${pc.cyan(`${detectedMarker}/agents/${cleanSlug}/SOUL.md`)} — fill in 페르소나·가치관`);
        console.log(`  3. Edit ${pc.cyan(`${detectedMarker}/agents/${cleanSlug}/TOOLS.md`)} — adjust 도구 정책 (산출물 폴더, 외부 의존성 정책)`);
        console.log(`  4. Run ${pc.cyan("paperclipai sync")} to push to PaperClip`);
      } catch (err) {
        handleCommandError(err);
      }
    });
}
