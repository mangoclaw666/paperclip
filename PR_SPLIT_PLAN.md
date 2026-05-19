# PR 분리 계획 (3개)

이 worktree 에서 한 일을 업스트림으로 보낼 때 3개 PR 로 분리 제안.
**현재 상태**: PR-1 은 별도 브랜치 ready. PR-2+3 는 한 commit 으로 합쳐져 있음 (`feat/managed-instructions-cli-baseline` 브랜치). 분리하려면 git surgery 필요.

---

## PR-1: Windows ESM URL + npm.cmd shell spawn

**브랜치**: `fix/windows-plugin-worker-esm` (이미 commit `f0fbf7f9` 존재)
**상태**: ✅ Ready to push

**변경**:
- `server/src/services/plugin-loader.ts` — `execArgv` 의 tsx 로더 경로를 `pathToFileURL().href` 로 감쌈
- `server/src/adapters/plugin-loader.ts` (line 180, 215) — `await import()` 와 `file://${modulePath}` 문자열 모두 `pathToFileURL` 사용
- `server/src/routes/adapters.ts` — npm install/uninstall execFileAsync 3 군데에 `shell: process.platform === "win32"` 추가

**고치는 것**:
- Windows 에서 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'` 로 plugin worker activation 실패
- `spawn npm ENOENT` (Windows 의 npm.cmd 는 spawn 으로 직접 못 띄움)

**관련 이슈**: closes #1263, #2013, #2057, #2122 (추정 — 실제 번호 확인 필요)

**push + PR**:
```bash
git push -u origin fix/windows-plugin-worker-esm
gh pr create --base master --head fix/windows-plugin-worker-esm \
  --title "fix(plugin-loader): wrap Windows absolute paths in file:// URLs for ESM loader" \
  --body-file <(git log -1 --format=%b f0fbf7f9)
```

---

## PR-2: Server — Managed instructions bundle + company-level prompt defaults + Workspace Bridge plugin

**브랜치**: 신규 `feat/server-managed-instructions` (TODO: split out from `feat/managed-instructions-cli-baseline`)
**상태**: ⏳ Surgery 필요 (현재 PR-3 와 한 commit 으로 합쳐져 있음)

**포함할 파일** (commit `88b1cede` 에서 cherry-pick 또는 manual reset):
- `packages/db/src/migrations/0087_company_agent_prompt_defaults.sql` (NEW)
- `packages/db/src/migrations/meta/_journal.json` (entry 87 추가)
- `packages/db/src/schema/companies.ts` (sharedInstructions, bootstrapTemplate, heartbeatTemplate columns)
- `packages/shared/src/types/company.ts`, `validators/company.ts` (관련 타입)
- `server/src/services/companies.ts` (CRUD 확장)
- `server/src/services/heartbeat.ts` (companyDefaults hook — agent 에 없으면 company 기본값으로 fallback)
- `ui/src/api/companies.ts`, `ui/src/pages/CompanySettings.tsx` (Agent Prompts UI)
- `packages/plugins/paperclip-plugin-hub-extensions/` (Workspace Bridge plugin — External Source 페이지 + Agent Prompts 페이지, core 가 아닌 plugin 으로 분리)

**제외할 파일** (PR-3 로 빼야 함):
- `cli/src/client/http.ts`
- `cli/src/commands/hub.ts`
- `cli/src/commands/agent-templates.ts`
- `cli/src/index.ts`

**고치는 것**:
- 회사 단위로 agent 공통 prompt 기본값 설정 가능 (DB column + heartbeat hook)
- Workspace Bridge plugin 으로 External Source / Agent Prompts UI 제공 (core fork 없이 plugin 표준 사용)
- 이미 master 에 있는 externalSource 기능 (commit `d680b236`) 확장

**git surgery 절차** (Monday 가 직접 또는 도구 도움받아):
```bash
git checkout -b feat/server-managed-instructions master
# Cherry-pick 88b1cede 한 다음 reset --soft, CLI 파일들만 unstage
git cherry-pick --no-commit 88b1cede
git reset HEAD cli/src/client/http.ts cli/src/commands/hub.ts \
  cli/src/commands/agent-templates.ts cli/src/index.ts
git checkout HEAD -- cli/src/client/http.ts cli/src/commands/hub.ts \
  cli/src/commands/agent-templates.ts cli/src/index.ts
# 또는 agent-templates.ts 는 untracked 이므로 rm
rm cli/src/commands/agent-templates.ts
git commit -m "feat(server): managed instructions bundle + company prompt defaults + Workspace Bridge plugin"
```

---

## PR-3: CLI — top-level rename + baseline templates + add-agent

**브랜치**: 신규 `feat/cli-baseline-and-rename` (PR-2 가 머지된 후 master 베이스)
**상태**: ⏳ Surgery 필요 (PR-2 의 server endpoint `/api/agents/:id/instructions-bundle/file` 에 의존하므로 PR-2 머지 후 만듦)

**포함할 파일**:
- `cli/src/client/http.ts` — `put<T>()` 메서드 추가
- `cli/src/commands/hub.ts` — 큰 리팩토링:
  - `paperclipai hub init|sync` → top-level `paperclipai init|sync`
  - 폴더 marker `_hub/` → `_paperclip/`
  - sync 가 `PUT /api/agents/:id/instructions-bundle/file` 호출 (각 `_paperclip/agents/<slug>/*.md` push)
  - sync 가 deprecated `adapterConfig.{prompt,bootstrap}Template` 강제 제거
  - init scaffold 가 leadership baseline 으로 ceo 4 파일 박음
  - 신규 `add-agent --role leadership|default <slug>` 명령
  - TASK.md scaffold frontmatter 가 `project:` / `assignee:` 사용 (server portability 가 읽는 키)
- `cli/src/commands/agent-templates.ts` (NEW) — leadership/default baseline TS 상수 + `composeAgentFiles()`
- `cli/src/index.ts` — `registerHubCommands` → `registerProjectCommands`

**고치는 것**:
- "hub" 라는 모호한 단어 제거 (`paperclipai init/sync/add-agent` 가 git 처럼 직관적)
- 영어 default AGENTS.md 가 박히는 문제 (관리되는 instructions bundle 로 한국어 baseline push)
- 매 회사마다 baseline 작성 부담 (drop-in template + `[채워 넣기: …]` 자리표시로 회사 specific 만 채우면 됨)
- PaperClip 표준 행동 룰 (탐색 금지·할 일 없으면 종료·API 호출 패턴) baseline 에 박혀 있음 → 모든 회사가 같은 ground rule 공유

**미그레이션 노트** (이 PR 머지 후 기존 사용자):
- `_hub/` 폴더 → `_paperclip/` 로 직접 rename (mv)
- 기존 `paperclipai hub sync` 스크립트 → `paperclipai sync` 로 교체

---

## 권장 순서

1. **PR-1 먼저 push + 머지** (독립, 다른 변경 안 받음)
2. **PR-2 surgery + push + 머지** (server endpoint 가 PR-3 의 prerequisite)
3. **PR-3 surgery + push + 머지** (PR-2 머지된 master 베이스)

또는 시간 없으면:
- PR-1 만 따로 보내고
- PR-2+3 는 `feat/managed-instructions-cli-baseline` 그대로 한 PR 로 (`88b1cede` 커밋) — 리뷰 부담은 크지만 일하기 빠름

---

## 우리가 추가로 만들었지만 PR 에 안 들어가는 것

- `~/.paperclip/instances/default/.env` — JWT secret. 로컬 dev 환경 setup. PaperClip 의 `paperclipai onboard` 가 정식으로 박는 자리. 문서로만 충분.
- coffee-lab/_paperclip/agents/{ceo,engineer}/*.md — 회사 specific instances. PR 에 안 감.
- `D:/00_WorkSpace/_templates/proposed-baseline/` — workspace 보관용. 이미 `cli/src/commands/agent-templates.ts` 안에 baked 됨.
- `_templates/paperclip-defaults/` — PaperClip 원본 영어 템플릿 수집본. 참고용. PR 안 감.
