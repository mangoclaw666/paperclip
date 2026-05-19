import { useEffect, useState } from "react";
import { useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

interface CompanyRecord {
  id: string;
  name: string;
  externalSource?: {
    type: "filesystem";
    rootPath: string;
    workspacePath?: string | null;
    syncCommand?: string | null;
    lastSyncedAt?: string | null;
  } | null;
  sharedInstructions?: string | null;
  bootstrapTemplate?: string | null;
  heartbeatTemplate?: string | null;
}

// Plugin UI is same-origin with PaperClip server, so a plain fetch with credentials works.
async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { credentials: "include" });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}`);
  return r.json();
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.json();
}

function useCompany(companyId: string | null | undefined) {
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (!companyId) return;
    apiGet<CompanyRecord>(`/companies/${companyId}`)
      .then((c) => { setCompany(c); setError(null); })
      .catch((e) => setError(String(e)));
  }, [companyId, reloadTick]);
  return { company, error, reload: () => setReloadTick((n) => n + 1) };
}

const box: React.CSSProperties = {
  border: "1px solid #2d2d35", borderRadius: 8, padding: 16, background: "#0f0f12",
};
const btn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6, border: "1px solid #3a3a44",
  background: "#1d1d23", color: "#eee", cursor: "pointer", fontSize: 13,
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#eee", color: "#111", border: "1px solid #ccc" };
const ta: React.CSSProperties = {
  width: "100%", minHeight: 140, padding: 8, borderRadius: 6,
  border: "1px solid #3a3a44", background: "transparent", color: "#eee",
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 13,
};

// ─── External Source page ─────────────────────────────────────────────────

export function ExternalSourcePage({ context }: PluginPageProps) {
  const { company, error } = useCompany(context.companyId);
  const [resyncOut, setResyncOut] = useState<string | null>(null);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "open-hub" | "open-ws" | "resync">(null);

  if (!context.companyId) return <div style={{ opacity: 0.7 }}>회사가 선택되지 않았어요.</div>;
  if (error) return <div style={{ color: "#f88" }}>회사 정보 로드 실패: {error}</div>;
  if (!company) return <div style={{ opacity: 0.7 }}>로드 중…</div>;

  const src = company.externalSource;

  return (
    <div style={{ maxWidth: 720, display: "grid", gap: 16, padding: 16, color: "#eee" }}>
      <h2 style={{ margin: 0 }}>External Source</h2>

      {!src ? (
        <div style={box}>
          이 회사는 로컬 출처가 없음. 까만 창에서 <code>paperclipai hub sync --path &lt;프로젝트&gt;</code> 한 번 돌리면 자동 등록.
        </div>
      ) : (
        <div style={{ ...box, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <div><span style={{ opacity: 0.6 }}>Source: </span><code>{src.rootPath}</code></div>
            {src.workspacePath && (
              <div><span style={{ opacity: 0.6 }}>Workspace: </span><code>{src.workspacePath}</code></div>
            )}
            <div>
              <span style={{ opacity: 0.6 }}>Last synced: </span>
              {src.lastSyncedAt ? new Date(src.lastSyncedAt).toLocaleString() : "없음"}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              style={btn}
              disabled={busy !== null}
              onClick={async () => {
                setBusy("open-hub"); setOpErr(null);
                try { await apiPost(`/companies/${company.id}/open`, { target: "hub" }); }
                catch (e) { setOpErr(String(e)); }
                finally { setBusy(null); }
              }}
            >Open folder</button>
            <button
              style={btn}
              disabled={busy !== null || !src.workspacePath}
              onClick={async () => {
                setBusy("open-ws"); setOpErr(null);
                try { await apiPost(`/companies/${company.id}/open`, { target: "workspace" }); }
                catch (e) { setOpErr(String(e)); }
                finally { setBusy(null); }
              }}
            >Open workspace</button>
            <button
              style={btnPrimary}
              disabled={busy !== null || !src.syncCommand}
              onClick={async () => {
                setBusy("resync"); setResyncOut(null);
                try {
                  const r = await apiPost<{ exitCode: number; stdout: string; stderr: string }>(`/companies/${company.id}/resync`, {});
                  setResyncOut(`[exit ${r.exitCode}]\n${r.stdout || "(no stdout)"}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}`);
                }
                catch (e) { setResyncOut(String(e)); }
                finally { setBusy(null); }
              }}
            >{busy === "resync" ? "Re-syncing…" : "Re-sync now"}</button>
          </div>
          {opErr && <div style={{ color: "#f88", fontSize: 12 }}>{opErr}</div>}
          {resyncOut && (
            <pre style={{ maxHeight: 240, overflow: "auto", background: "#0a0a0d", padding: 12, borderRadius: 6, fontSize: 12, margin: 0 }}>{resyncOut}</pre>
          )}
          {!src.syncCommand && (
            <div style={{ opacity: 0.6, fontSize: 12 }}>
              syncCommand 미설정. CLI 가 sync 시 자동으로 채워줍니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Prompt Defaults page ────────────────────────────────────────────────

export function AgentPromptsPage({ context }: PluginPageProps) {
  const { company, error, reload } = useCompany(context.companyId);
  const [shared, setShared] = useState("");
  const [bootstrap, setBootstrap] = useState("");
  const [heartbeat, setHeartbeat] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!company) return;
    setShared(company.sharedInstructions ?? "");
    setBootstrap(company.bootstrapTemplate ?? "");
    setHeartbeat(company.heartbeatTemplate ?? "");
  }, [company]);

  if (!context.companyId) return <div style={{ opacity: 0.7 }}>회사가 선택되지 않았어요.</div>;
  if (error) return <div style={{ color: "#f88" }}>회사 정보 로드 실패: {error}</div>;
  if (!company) return <div style={{ opacity: 0.7 }}>로드 중…</div>;

  const dirty =
    shared !== (company.sharedInstructions ?? "") ||
    bootstrap !== (company.bootstrapTemplate ?? "") ||
    heartbeat !== (company.heartbeatTemplate ?? "");

  async function save() {
    if (!company) return;
    setSaving(true); setSaveMsg(null);
    try {
      await apiPatch(`/companies/${company.id}`, {
        sharedInstructions: shared.trim() ? shared : null,
        bootstrapTemplate: bootstrap.trim() ? bootstrap : null,
        heartbeatTemplate: heartbeat.trim() ? heartbeat : null,
      });
      setSaveMsg("저장됨");
      reload();
    } catch (e) {
      setSaveMsg(`저장 실패: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 880, display: "grid", gap: 16, padding: 16, color: "#eee" }}>
      <h2 style={{ margin: 0 }}>Agent Prompts</h2>

      <div style={{ ...box, fontSize: 12, lineHeight: 1.6 }}>
        모든 agent 에 자동 주입되는 공통 글 3개. 각 agent 가 같은 칸을 따로 설정하면 그것이 우선, 없으면 여기 값.
      </div>

      <div style={{ ...box, display: "grid", gap: 16 }}>
        <Section label="Shared Instructions" hint="모든 agent AGENTS.md 앞에 합쳐질 회사 공통 글 (현재 DB 저장만, adapter hook 은 다음 단계)">
          <textarea style={ta} value={shared} onChange={(e) => setShared(e.target.value)} placeholder="# 회사 공통 룰&#10;&#10;모든 agent 는 한국어로 응답한다…" />
        </Section>

        <Section label="Bootstrap Prompt Template" hint="agent 가 깨어날 때 가장 먼저 보는 글. 비워두면 PaperClip 기본값(없음).">
          <textarea style={ta} value={bootstrap} onChange={(e) => setBootstrap(e.target.value)} placeholder="# 한국어 모드&#10;&#10;당신은 한국어 회사의 agent…" />
        </Section>

        <Section label="Heartbeat Prompt Template" hint="매 cycle 마다 주어지는 행동 지침. 비워두면 PaperClip 영어 기본값.">
          <textarea style={ta} value={heartbeat} onChange={(e) => setHeartbeat(e.target.value)} placeholder="# Heartbeat 행동 지침&#10;&#10;당신은 agent {{agent.id}}…" />
        </Section>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={btnPrimary} onClick={save} disabled={!dirty || saving}>
            {saving ? "저장 중…" : "Save"}
          </button>
          {saveMsg && <span style={{ fontSize: 12, opacity: 0.8 }}>{saveMsg}</span>}
        </div>
      </div>

      <div style={{ ...box, fontSize: 12, lineHeight: 1.7 }}>
        <strong>어떻게 작동하나</strong>
        <ol style={{ paddingLeft: 18, marginTop: 8, marginBottom: 0 }}>
          <li>여기서 저장 → DB <code>companies.bootstrap_template / heartbeat_template / shared_instructions</code> 칸에 기록.</li>
          <li>agent 가 깨어남.</li>
          <li>서버가 그 agent 의 adapter 설정 확인. <code>bootstrapPromptTemplate</code> 같은 칸이 비어 있으면 위 회사 값으로 채움.</li>
          <li>Claude Code 가 그 값을 LLM 에 넘김 (bootstrap = 제일 위, heartbeat = 매 cycle 행동 지침 위치).</li>
          <li>LLM 이 한국어 기조로 사고·응답.</li>
        </ol>
      </div>
    </div>
  );
}

function Section({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>{hint}</span>
      {children}
    </label>
  );
}

// ─── Sidebar links — appear in the company sidebar under PaperClip's nav ─

function SidebarLink({ label, route, icon }: { label: string; route: string; icon: string }) {
  const nav = useHostNavigation();
  const href = nav.resolveHref(route);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  const linkProps = nav.linkProps(route);
  return (
    <a
      {...linkProps}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span aria-hidden="true" style={{ width: 16, textAlign: "center" }}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}

export function ExternalSourceSidebarLink(_props: PluginSidebarProps) {
  return <SidebarLink label="External Source" route="/workspace-bridge-external-source" icon="📁" />;
}

export function AgentPromptsSidebarLink(_props: PluginSidebarProps) {
  return <SidebarLink label="Agent Prompts" route="/workspace-bridge-agent-prompts" icon="✨" />;
}
