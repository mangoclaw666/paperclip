# PATCH_NOTES — master (running log)

> Chronological working log of fork_mangoclaw changes on `master`. Most recent at the top.

---

## [2026-05-20] sync: instructions push 폐기 → external mode 전환

### TL;DR

`paperclipai sync` 가 매번 agent instructions 마크다운을 PaperClip 인스턴스 폴더로 PUT 하던 부분 제거. PaperClip 의 `instructionsBundleMode: "external"` 모드 사용으로 전환. workspace 가 source-of-truth — agent 가 매 cycle workspace 의 `_ops/agents/<slug>/*.md` 를 직접 읽음.

### Why

원래 sync 의 instructions PUT 로직은 PaperClip 의 default mode (`managed`) 가정으로 짜인 것. external 모드의 존재를 처음에 안 살핀 잘못. 결과:
- workspace 파일 수정 후 sync 재실행 빠뜨리면 agent 가 옛 내용 그대로 읽음
- Make 의 Director 가 옛 HEARTBEAT.md 들고 14 cycle 헛돌이 + $21 낭비
- 매번 sync 명령 돌리는 mental overhead

external 모드 = workspace 직접 참조 = sync 자체가 instructions 동기화에 불필요.

### What changed

- `cli/src/commands/fork_mangoclaw/ops.ts` — sync 의 agent 처리 블록 (line 727~762) 대체. instructions 파일 PUT 루프 제거. 대신 `PATCH /api/agents/{id}/instructions-bundle` 한 번 (mode=external, rootPath=`<workspace>/_ops/agents/<slug>`) 로 끝.
- `cli/src/commands/fork_mangoclaw/_archive/sync-managed-instructions-2026-05-20.md` (신규) — 옛 코드 + 폐기 사연 보관.
- `cli/src/commands/fork_mangoclaw/README.md` — sync 의 진짜 용도 표 갱신.
- `CLAUDE.md` — "운영 모델 — Workspace 가 Source-of-Truth" 섹션 신설.
- Make 회사 5명 agent (ceo/engineer/architect/writer/editor) external 모드 전환 (DB PATCH 완료).

### 관련 발견

- PaperClip 의 `enableIsolatedWorkspaces` 와는 별개. instructions 와 cwd 는 다른 트랙.
- agent cwd 도 격리 폴더로 가는 문제는 별도 (heartbeat.ts 의 `ensureManagedProjectWorkspace`) — 진행 중.

---

## [2026-05-20] OKR system — kind field + cascade automations + UI split

### TL;DR

Goals now carry an explicit `kind` field (`mission / vision / objective / key_result / other`), the Goals page is split into two sections (Mission·Vision cards top, OKR tree bottom), two cascade automations fire server-side when KRs or Issues complete, and the New Goal Dialog has a kind selector with parent-based inference.

### Why

PaperClip's flat Goals list conflated absolute standards (Mission/Vision) with measurable OKRs (Objective/KR). Introducing `kind` lets the UI render them differently and lets cascades propagate status automatically.

### What changed

#### DB + Shared

- `packages/db/src/migrations/0091_goal_kind.sql` (new) — `ALTER TABLE goals ADD COLUMN kind text` + index on `(company_id, kind)`.
- `packages/db/src/schema/goals.ts` — added `kind: text("kind")` column.
- `packages/shared/src/constants.ts` — `GOAL_KINDS` array + `GoalKind` type.
- `packages/shared/src/types/goal.ts` — `kind?: GoalKind | null` field.
- `packages/shared/src/validators/goal.ts` — `kind: z.enum(GOAL_KINDS).optional().nullable()`.

#### Server cascades

`server/src/services/goals.ts` — cascade A2: when a KR is updated to `achieved`, if all sibling KRs under the same Objective are `achieved`, the Objective is promoted to `achieved` automatically.

`server/src/services/issues.ts` — cascade A3: when an Issue is closed (`done` / `cancelled`), if all Issues in the parent Project are closed, the Project is set to `completed` automatically.

#### UI

| File | Change |
|---|---|
| `ui/src/components/OkrTree.tsx` (new) | OKR-only tree — filters out mission/vision, promotes orphans to root |
| `ui/src/components/MissionVisionCards.tsx` (new) | Card grid for mission/vision goals; links to detail page |
| `ui/src/pages/Goals.tsx` | 2-section layout: Mission·Vision (top) + OKR tree (bottom) |
| `ui/src/components/NewGoalDialog.tsx` | Kind selector chip + parent-based kind inference |
| `ui/src/lib/status-colors.ts` | `statusBadgeByNs.goal` — planned=amber, active=blue, achieved=green, cancelled=gray |
| `ui/src/components/StatusBadge.tsx` | Uses `statusBadgeByNs` override before falling back to generic |
| `ui/src/i18n/locales/en.json` | Added `companySettings` block (fix: was in ko.json only, causing validation error) |

#### Plugins

- `packages/plugins/paperclip-plugin-catalog/` (new) — Agent Roles catalog page with 12 role cards; labels distinguish PaperClip-official vs author-guidance entries.

### Files touched

```
New:
  packages/db/src/migrations/0091_goal_kind.sql
  ui/src/components/MissionVisionCards.tsx
  ui/src/components/OkrTree.tsx
  packages/plugins/paperclip-plugin-catalog/  (entire plugin)

Modified:
  packages/db/src/migrations/meta/_journal.json
  packages/db/src/schema/goals.ts
  packages/shared/src/constants.ts
  packages/shared/src/index.ts
  packages/shared/src/types/goal.ts
  packages/shared/src/validators/goal.ts
  server/src/services/goals.ts
  server/src/services/issues.ts
  ui/src/components/NewGoalDialog.tsx
  ui/src/components/StatusBadge.tsx
  ui/src/lib/status-colors.ts
  ui/src/pages/Goals.tsx
  ui/src/i18n/locales/en.json
```

---

## [prior] feature/dashboard-external-source

> This was a working snapshot for the branch `feature/dashboard-external-source`. It serves as Monday's reference and as a draft for the eventual PR description.

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

---

# PATCH_NOTES — feature/eco-mode (overlay)

> 별도 변경 묶음. dashboard-external-source 와 무관. 같이 commit 되어 있을 뿐.

## TL;DR

`heartbeat.ecoMode = true` 로 켜면, timer wake 시 LLM 호출 직전에 cheap SQL diff 로 변화 점검 → 변화 없으면 LLM spawn 안 함. idle agent 의 cost burn 을 0 에 가깝게.

## Why

PaperClip Native (claude_local 등) 는 매 cycle 마다 LLM 호출 → idle agent (inbox 0) 도 prompt cache create 비용 발생. Opus 모델 + 5분 cycle 운영 시 시간당 $15~25 / agent 까지 burn. 옛 brain.py 시대에 cron 이 `has_changes()` 로 file mtime + count 만 보고 변화 없으면 LLM skip 한 패턴을 PaperClip DB schema 로 옮긴 것.

## What changed

### 새 모듈: `server/src/services/eco-mode.ts`

Pure functions (DB 의존만):
- `loadEcoSnapshot(stateJson)` — `agentRuntimeState.stateJson.lastEcoSnapshot` 파싱
- `buildEcoSnapshot(now)` — `{ version: 1, checkedAt: ISO }` 객체 생성
- `saveEcoSnapshot(db, agentId, snapshot)` — jsonb `||` merge (다른 키 보존)
- `detectChangesForEcoMode(db, agent, lastSnapshot, opts)` — 5가지 분기:
  1. `first_wake` (snapshot=null)
  2. `snapshot_invalid` (NaN checkedAt)
  3. `max_idle_exceeded` (now − checkedAt > maxIdleHours)
  4. 변화 시그널 3종 — `issue_changed` / `new_comment` / `external_wakeup`
  5. `no_signals` — skip

마이그레이션 0개 (jsonb free-form 활용).

### `heartbeat.ts` 변경

- `parseHeartbeatPolicy` 에 `ecoMode: boolean` (default false) + `maxEcoIdleHours: number` (default 6) 필드 추가
- `enqueueWakeup` 의 timer 분기 (기존 `heartbeat.disabled` skip 옆) 에 eco-mode gate 추가
  - source != "timer" (assignment / on_demand / automation / mention) 는 게이트 우회 → cascade 보장
  - 변화 없음 → `writeSkippedRequest("eco.no_changes:<reason>")` (기존 skipped 패턴 재사용)
  - 변화 있음 → snapshot 저장 + 정상 enqueue

### 새 테스트: `server/src/__tests__/heartbeat-eco-mode.test.ts`

embedded postgres 기반 12 시나리오 — 코덱 round-trip, snapshot merge 보존, first wake, invalid snapshot, max idle, no signals, issue changed, issue 다른 assignee, new comment, external wakeup, timer self-noise 제외. 12/12 PASS.

### UI

`ui/src/components/AgentConfigForm.tsx` 의 "Advanced Run Policy" 섹션에 토글 추가:
- "Eco mode (skip wake when nothing changed)" 체크박스
- 켜면 "Max idle hours (safety wake)" 입력 노출 (default 6)

`agent-config-primitives.tsx` 의 `help` 에 hint 2개 추가.

## Out of scope / future work

- **Director 의 자율 cascade 시그널** — 현재 Director 도 ecoMode 켜면 본인 inbox 변화만 봄. 회사 전체 시그널 (KR 측정 변화, Backlog promote 후보) 추가하면 Director 도 절약 가능. Default `ecoMode=false` 라 운영자가 명시적으로 켜는 동안만 영향.
- **Plugin SDK 의 `onBeforeAgentWake` hook** — eco-mode 가 본체에 들어가는 게 더 자연스럽지만, 같은 패턴을 plugin 으로 노출하려면 SDK 확장 필요.
- **드리프트 모니터** — `eco.no_changes:<reason>` 의 distribution 을 dashboard 에서 시각화.

## Verification

1. `pnpm --filter @paperclipai/server typecheck` — PASS
2. `pnpm --filter @paperclipai/ui typecheck` — PASS
3. `cd server && npx vitest run heartbeat-eco-mode` — 12/12 PASS
4. (운영 검증) Make 회사에서 4 default agent ecoMode=true 로 켠 후 24h burn 측정 — 본 PR 후속.

## Upstream PR 후보

- 마이그레이션 0개, 새 file 2개, heartbeat.ts patch ~30 줄. 격리도 높음.
- `fork_mangoclaw:` 마커는 PR 보낼 때 영어로 정리 + 제거.
