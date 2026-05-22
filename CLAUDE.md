# PaperClip fork — CLAUDE.md

이 파일은 `D:\00_WorkSpace\50_PaperClip` 프로젝트에 적용된다.
워크스페이스 공통 규칙은 `D:\00_WorkSpace\CLAUDE.md` 를 따른다.

---

## 프로젝트 개요

| 항목 | 값 |
|---|---|
| 저장소 | PaperClip OSS fork (`mangoclaw666`) |
| 브랜치 정책 | `master` 직접 커밋 (솔로 개발, PR 불필요) |
| pnpm 모노레포 패키지 | `server/`, `ui/`, `cli/`, `packages/db`, `packages/shared`, `packages/plugins/*` |
| 서버 시작 | `pnpm dev:server` (포트 3100, banner 에서 `Agent JWT: set` 확인) |
| Make 회사 ID | `84fbd41c-9439-415e-82e1-69cfbbf144d3` |
| embedded PostgreSQL | 포트 54329 |

---

## fork_mangoclaw 컨벤션

### 코드 마커

| 마커 | 용도 | 예시 |
|---|---|---|
| `// fork_mangoclaw:` | 한 줄 설명 주석 | `// fork_mangoclaw: OKR layer label` |
| `// fork_mangoclaw: <제목>` + 블록 | 새 섹션/함수 추가 | 새 함수 바로 위에 |
| `fork_mangoclaw/` 서브폴더 | 완전히 새로운 파일 묶음 | `ui/src/components/fork_mangoclaw/` |

### 원칙

1. **최소 침습** — PaperClip 기존 코드 최대한 유지. 변경은 마커 달고 격리
2. **fallback 우선** — 새 필드는 optional/nullable. 기존 데이터 깨지지 않게
3. **마이그레이션 번호** — 현재 사용 중: 0091 (goal_kind). 다음은 0092부터

---

## 주요 변경 이력

### OKR 시스템 (2026-05-20)

- `goals.kind` 필드: `mission | vision | objective | key_result | other`
- Goals 페이지: Mission·Vision 카드(상단) + OKR 트리(하단)
- 캐스케이드 A2 (KR→Objective), A3 (Issue→Project)
- New Goal Dialog: kind 선택 칩 + 부모 기반 추론
- Status 색상: Goal active = blue (기본 green 과 다름)

### 이전 주요 변경

| 날짜 | 변경 |
|---|---|
| 2026-05 | eco-mode (절전 모드) — 변화 없을 때 LLM 호출 건너뜀 |
| 2026-05 | i18n-ko — 한국어 병기 UI + 플러그인 토글 |
| 2026-05 | identifier 시스템 — 프로젝트·골 자동 번호 + sort_order |
| 2026-05 | hub sync CLI (`paperclipai hub sync`) |
| 2026-05 | external-source — 회사가 디스크 경로 기억 + 대시보드 re-sync |

---

## 플러그인 목록

| 플러그인 ID | 역할 |
|---|---|
| `mangoclaw666.paperclip-plugin-catalog` | Agent Roles 카탈로그 페이지 |
| `mangoclaw666.paperclip-plugin-fake-sandbox` | 개발용 샌드박스 시뮬레이션 |
| `mangoclaw666.paperclip-plugin-hub-extensions` | Hub 이동/동기화 확장 |
| `mangoclaw666.paperclip-plugin-i18n-ko` | 한국어 로케일 토글 |
| `plugin-llm-wiki` | LLM 용어 위키 참조 |

플러그인 ID 규칙: `mangoclaw666.<플러그인명>` (PaperClip 공식 `paperclipai.*` 와 구분)

---

## i18n 규칙

- **ko.json 에 추가한 키는 반드시 en.json 에도 추가**
- ko.json 에만 있으면 locale 검증 오류 (`is not defined in English`) 발생
- 누락된 en.json 키 → 영어 텍스트로 추가 (한국어에서 괄호 안 영어 부분 발췌)
- 새 컴포넌트에서 `useTranslation()` 쓸 때는 `defaultValue` 필수 (하드코딩 fallback)

---

## 개발 주의사항

- **Windows 환경**: symlink 는 Developer Mode 필수 (skill materializer)
- **서버 중복 실행 금지**: 3100 이 이미 열려 있으면 3101 fallback → 이전 프로세스 먼저 종료
  ```
  Get-Process -Name node | Stop-Process  (또는 PID 확인 후 개별 종료)
  ```
- **DB 마이그레이션**: `packages/db/src/migrations/meta/_journal.json` 에 엔트리 추가 필수
- **tsc 체크**: `pnpm --filter @paperclipai/shared tsc --noEmit` 로 타입 먼저 확인
- **Windows build-script 버그**: `pnpm build` 서버 post-tsc `mkdir -p` 실패 → 기존 known issue, 무시

---

## 운영 모델 — Workspace 가 Source-of-Truth (2026-05-20)

| 측면 | 정책 |
|---|---|
| **Agent instructions** | `instructionsBundleMode: "external"`. PaperClip 이 workspace 의 `_ops/agents/<slug>/` 를 직접 읽음 |
| **Agent cwd** | workspace 직접 (`D:/00_WorkSpace/<프로젝트>/`). 격리 폴더 X (단, `enableIsolatedWorkspaces=false` 기본값 유지) |
| **DB 데이터 (goals/projects/issues)** | DB 가 truth. workspace 의 `_ops/goals/*.md` 등은 export/import 보조 |
| **externalSource** | 각 회사가 어느 workspace 에서 왔는지 DB 에 기록 (UI 의 "Open folder" / "Re-sync" 위해) |

### `paperclipai sync` 가 하는 일

1. Company import / agent upsert
2. Goals / Projects / Issues markdown → DB upsert
3. Agent adapterConfig PATCH (cwd + legacy prompt template 제거)
4. **Agent instructions PATCH** — `mode: external` + `rootPath` 박기 (idempotent)
5. externalSource PATCH

**더 이상 안 함**: instructions 파일 PUT (managed 모드 가정의 잔재 — 2026-05-20 제거. `cli/src/commands/fork_mangoclaw/_archive/sync-managed-instructions-2026-05-20.md` 참조)

### 절대 하지 말 것

- agent 의 `instructionsBundleMode` 를 `managed` 로 되돌리기 — workspace 변경이 안 반영됨
- `~/.paperclip/instances/default/companies/<cid>/agents/<aid>/instructions/` 폴더를 직접 수정 — external 모드는 거기 안 봄
- `paperclipai sync` 를 "instructions 동기화" 로 설명하기 — 이제는 DB 데이터 upsert 전용

---

## MAKE CEO 에이전트 설정

| 항목 | 값 |
|---|---|
| 에이전트 이름 | `MAKE CEO` |
| 역할 | Director (리더십) |
| Instructions 모드 | **`external`** |
| Instructions rootPath | `D:\00_WorkSpace\02_Make\_ops\agents\ceo` |
| sync 추론 로직 | 에이전트 이름 마지막 단어 소문자 → 폴더명 (`CEO` → `ceo`) |
| maxConcurrentRuns | 1 |
| 월 예산 | $30 (전체 합산 $50: Director 30 + 일반 4명 × 5) |

Director 규칙은 `agents/ceo/AGENTS.md` 참조. OKR 라이프사이클, 자기 위임 금지, KR 측정 기준 강제, 70% promote rule, parallel work rule 포함.
