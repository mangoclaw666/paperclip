# PATCH_NOTES — feature/dashboard-external-source

> This is a working snapshot for the branch `feature/dashboard-external-source`. It serves as Monday's reference and as a draft for the eventual PR description.

## TL;DR

A company can now record the local filesystem path it was imported from. Once linked, the dashboard shows the source, lets you open the folder in your OS file explorer, and lets you re-sync from disk with one click. A new CLI command `paperclipai hub sync` does the import + goal POST + externalSource PATCH in a single call, removing the need for per-project sync scripts.

## Why

Projects following the `_hub/` portable pattern (agents/goals/projects/tasks as markdown) had to ship their own per-project sync script — duplicated work, brittle to PaperClip API changes, no link back to disk from the dashboard. This branch closes both gaps:

1. **Engine-side sync** — `paperclipai hub sync` is a built-in CLI command. No project script needed.
2. **Dashboard link-back** — companies remember where they came from on disk, the Settings page surfaces the source + actions.

## What changed

### New CLI command: `paperclipai hub sync`

`cli/src/commands/hub.ts` (new), wired in `cli/src/index.ts`.

- Walks `./_hub/` (or `--path <dir>/_hub`), packages agents/projects/tasks into the existing portable manifest, calls `POST /companies/imports/apply` (or `/companies/import` for new-company mode).
- Goals are not in the portability manifest; the command POSTs each `_hub/goals/<slug>/GOAL.md` to `POST /companies/{cid}/goals` separately. Normalizes `status: in_progress` → `active` to match PaperClip's enum.
- After successful import, PATCHes the company's `externalSource` with `rootPath`, `workspacePath`, `syncCommand`, `lastSyncedAt`.
- Reuses `resolveInlineSourceFromPath` and `resolveCompanyImportApiPath` from `commands/client/company.ts` — no duplicated import logic.
- Options: `--path`, `--collision`, `--new-company-name`, `--skip-goals`, `--skip-external-source`, `--sync-command`, `--workspace-path`, plus standard `--api-base/--api-key/--company-id` from `addCommonClientOptions`.

### New DB column + migration

- `packages/db/src/schema/companies.ts` — adds `externalSource: jsonb("external_source")` typed as `CompanyExternalSource`.
- `packages/db/src/migrations/0086_company_external_source.sql` — `ALTER TABLE companies ADD COLUMN IF NOT EXISTS external_source jsonb`.
- `packages/db/src/migrations/meta/_journal.json` — entry 86 appended.

### New shared types + validators

- `packages/shared/src/types/company.ts` — `CompanyExternalSource` interface, `Company.externalSource?` field (optional to avoid breaking fixtures).
- `packages/shared/src/validators/company.ts` — `companyExternalSourceSchema`, `updateCompanyExternalSourceSchema`, `companyOpenTargetSchema`.
- Re-exports added in `validators/index.ts`, `types/index.ts`, and top-level `src/index.ts`.

### New server endpoints (local trusted mode only)

`server/src/routes/companies.ts`:

| Method | Path | Body | Purpose |
|---|---|---|---|
| `PATCH` | `/api/companies/:companyId/external-source` | `{ externalSource: {...} \| null }` | Set/clear the company's externalSource |
| `POST` | `/api/companies/:companyId/open` | `{ target: "hub" \| "workspace" }` | Open `rootPath` or `workspacePath` in OS file explorer (`explorer.exe` / `open` / `xdg-open`) |
| `POST` | `/api/companies/:companyId/resync` | `{}` | Run the configured `syncCommand` in `cwd = workspacePath`, stream stdout/stderr, refresh `lastSyncedAt` |

All three are gated by `requireLocalImplicit(req)` — `actor.type === "board" && actor.source === "local_implicit"`. Authenticated remote callers receive `403 forbidden`.

`runResyncCommand` runs the stored command through the shell with a 120s timeout, captures up to 50KB stdout + 50KB stderr.

`server/src/services/companies.ts` — adds `externalSource` to `companySelection` so the field is returned by GET endpoints.

### Dashboard UI

`ui/src/api/companies.ts` — three new API methods + `CompanyResyncResult` type.

`ui/src/pages/CompanySettings.tsx` — new "External Source" section (rendered only when `selectedCompany.externalSource` is set):

- Shows `rootPath`, `workspacePath` (if any), and `lastSyncedAt` (or "never").
- Three buttons: **Open folder**, **Open workspace**, **Re-sync now**.
- Re-sync output rendered in a max-h-64 scrollable `<pre>` log box.
- Re-sync button is disabled if `syncCommand` is unset.
- Error states surfaced inline.

### Docs

- `docs/companies/external-source.md` (new) — full reference for the feature: concept diagram, schema, CLI usage, dashboard behavior, REST surface, security notes, future work.

## Security notes

- All three new endpoints require **local trusted mode**. Servers running in `authenticated` (remote-admin) mode reject these with 403.
- The `syncCommand` is set at sync time via the CLI's PATCH call. The Re-sync button runs the stored command verbatim — the dashboard never accepts arbitrary commands.
- The OS open endpoint accepts only `target: hub|workspace`. It can only open paths already recorded in `externalSource`.
- Command output is bounded (50KB each for stdout/stderr) to prevent runaway logs.

## Files touched

```
New:
  cli/src/commands/hub.ts
  docs/companies/external-source.md
  packages/db/src/migrations/0086_company_external_source.sql

Modified:
  cli/src/index.ts
  packages/db/src/migrations/meta/_journal.json
  packages/db/src/schema/companies.ts
  packages/shared/src/index.ts
  packages/shared/src/types/company.ts
  packages/shared/src/types/index.ts
  packages/shared/src/validators/company.ts
  packages/shared/src/validators/index.ts
  server/src/routes/companies.ts
  server/src/services/companies.ts
  ui/src/api/companies.ts
  ui/src/pages/CompanySettings.tsx
```

14 files (3 new, 11 modified).

## Build + type-check status

| Package | Result |
|---|---|
| `@paperclipai/shared` | tsc clean |
| `@paperclipai/db` | tsc clean |
| `@paperclipai/server` | `tsc --noEmit` clean (0 errors) |
| `@paperclipai/cli` | `tsc --noEmit` clean |
| `ui` | `tsc --noEmit` clean |

The `pnpm build` for server fails on the post-tsc `mkdir -p && cp -R` step in Windows shells (this is a pre-existing build-script issue unrelated to this branch).

## Companion change in the sister project

The companion test project `D:/00_WorkSpace/51_coffee-lab` (separate repo, not part of this branch) previously shipped its own `scripts/paperclip/sync_portable.py`. That entire `scripts/` folder is now deleted there; the project uses `paperclipai hub sync` instead.

## Out of scope / future work

- **Drift detection** between disk and Paperclip (stale-source badge).
- **"Connected Workspaces" sidebar section** listing every company with `externalSource` set (waits until 2+ such companies exist).
- **`paperclipai hub export`** — write Paperclip state back into `_hub/` markdown.
- **Externalsource may store paths that no longer exist** — currently no validation. Could check at open/resync time and surface a UI warning.

## Verification (manual, end-to-end)

1. PaperClip dev server up: `cd <worktree> && pnpm dev` (this branch runs on port 3101 to avoid conflict with the main install).
2. Onboard, create a board user, generate a board API key.
3. Set env vars: `PAPERCLIP_API_URL=http://localhost:3101`, `PAPERCLIP_API_KEY=<key>`.
4. From the companion project root: `paperclipai hub sync`.
5. Open the company's Settings page → "External Source" section appears with path, last synced time, three buttons.
6. Click "Open folder" — OS file explorer opens at `_hub/`.
7. Click "Re-sync now" — output appears in the log box, `lastSyncedAt` updates.
8. (Negative) In `authenticated` deployment mode, the section's buttons are gated and the API returns 403.
