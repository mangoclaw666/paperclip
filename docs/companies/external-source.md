# External Source — link a company to a local on-disk source

A company can record the local filesystem path it was imported from. Once linked, the dashboard shows the source location and exposes three one-click actions: open the source folder, open the project workspace, and re-sync the company from disk.

This is the standard workflow for any project that keeps its agents, projects, and tasks as markdown under a `_hub/` directory and pushes them to Paperclip with `paperclipai hub sync`.

## Concept

```
project on disk                     Paperclip instance
─────────────────────────           ─────────────────────────
my-project/                         Company "my-project"
├─ _hub/                <── PATCH ───┤ externalSource: {
│  ├─ .paperclip.yaml                │   type: "filesystem",
│  ├─ agents/...                     │   rootPath: ".../my-project/_hub",
│  ├─ projects/...                   │   workspacePath: ".../my-project",
│  ├─ goals/...                      │   syncCommand: "paperclipai hub sync",
│  └─ tasks/...                      │   lastSyncedAt: "2026-05-19T..."
└─ app/  (workspace)                 │ }
                                     └─ Settings page shows source banner + 3 buttons
```

The `externalSource` field is a JSONB column on `companies`. It is only meaningful when Paperclip and the disk path are on the same host (or a host the Paperclip server can reach via the OS file explorer).

## Schema

```ts
interface CompanyExternalSource {
  type: "filesystem";
  rootPath: string;          // absolute path to the _hub/ root
  workspacePath?: string;    // absolute path to the project root (often parent of rootPath)
  syncCommand?: string;      // command the dashboard "Re-sync" button runs
  lastSyncedAt?: string;     // ISO timestamp set on every successful sync
}
```

Migration: `0086_company_external_source.sql`.

## CLI — `paperclipai hub sync`

Walks `./_hub/` (or `--path <dir>/_hub`), pushes the portable bundle, posts goals, and patches `externalSource`. One command does what previously required a per-project sync script.

```bash
# From any project root that has a _hub/ folder:
paperclipai hub sync

# First run creates a new company (named after the folder). Subsequent runs
# need a companyId in env or context, or pass --company-id explicitly:
paperclipai hub sync --company-id <uuid>

# Common options:
#   --collision rename|skip|replace        (default: replace)
#   --new-company-name <name>              (override default folder-name)
#   --skip-goals                           skip goal POSTs
#   --skip-external-source                 don't patch externalSource
#   --sync-command "<cmd>"                 override the syncCommand stored on the company
```

The portable manifest does not carry goals, so the CLI POSTs each `_hub/goals/<slug>/GOAL.md` to `POST /api/companies/{cid}/goals` separately. Goal status `in_progress` is normalized to `active` (Paperclip's goal status enum).

## Dashboard UI

When a company has `externalSource` set, **Settings → External Source** shows:

- **Source** — the `rootPath`
- **Workspace** — the `workspacePath` (if set)
- **Last synced** — `lastSyncedAt` formatted as local time, or `never`
- **[Open folder]** — opens `rootPath` in the OS file explorer
- **[Open workspace]** — opens `workspacePath` (or falls back to `rootPath`)
- **[Re-sync now]** — runs `syncCommand` in `cwd = workspacePath`; the output is shown in a fixed-height log box and `lastSyncedAt` is updated on success

The section is hidden entirely for companies without `externalSource`.

## REST API

All three endpoints below are gated to **local trusted mode only** (the actor must satisfy `actor.type === "board" && actor.source === "local_implicit"`). Authenticated remote callers get `403 forbidden`.

### `PATCH /api/companies/:companyId/external-source`

Set or clear the external source for a company. Body:

```json
{
  "externalSource": {
    "type": "filesystem",
    "rootPath": "/abs/path/to/_hub",
    "workspacePath": "/abs/path/to/project",
    "syncCommand": "paperclipai hub sync",
    "lastSyncedAt": "2026-05-19T12:34:56Z"
  }
}
```

Pass `{ "externalSource": null }` to clear.

### `POST /api/companies/:companyId/open`

Open the configured path in the OS file explorer. Body:

```json
{ "target": "hub" | "workspace" }
```

`hub` opens `rootPath`. `workspace` opens `workspacePath`, falling back to `rootPath` if not set. Uses `explorer.exe` on Windows, `open` on macOS, `xdg-open` on Linux.

Returns `{ opened: <path> }` on success.

### `POST /api/companies/:companyId/resync`

Run the configured `syncCommand` (`cwd = workspacePath ?? rootPath`). The command runs through the shell with a 120-second timeout. Returns:

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "company": { /* updated company with refreshed lastSyncedAt */ }
}
```

Throws `400` if `externalSource` is missing or `syncCommand` is not configured.

## Security notes

- All three endpoints require the local trusted mode. Remote-administered (`authenticated` mode) Paperclip servers reject these calls with `403`.
- The `syncCommand` is set at sync time (via the CLI's PATCH call). The dashboard's Re-sync button runs that stored command verbatim — it never accepts arbitrary commands from the UI.
- The OS open endpoint takes only `target: hub|workspace`. It does not accept arbitrary paths; it can only open paths already recorded in `externalSource`.
- Command output is truncated to 50KB stdout + 50KB stderr to prevent runaway logs.

## Future work

- Drift detection between disk and Paperclip (mark stale companies with a badge).
- "Connected Workspaces" sidebar section listing every company with `externalSource` set (relevant once 2+ such companies exist).
- `paperclipai hub export` — opposite direction, write Paperclip state back into `_hub/` markdown.
