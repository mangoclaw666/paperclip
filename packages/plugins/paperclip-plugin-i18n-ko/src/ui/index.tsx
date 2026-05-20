import { useEffect, useState } from "react";
import { type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

// fork_mangoclaw: Korean toggle. Reads/writes localStorage key
// "paperclip:i18n:lang" and fires a CustomEvent that core App.tsx listens for.
// The handshake (event name + storage key) is documented in the README and
// must stay in sync with the core App.tsx listener.

const STORAGE_KEY = "paperclip:i18n:lang";
const EVENT_NAME = "paperclip:i18n:setLanguage";

type Lang = "en" | "ko";

function readLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "ko" ? "ko" : "en";
}

function setLang(next: Lang): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, next);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { lang: next } }));
}

export function LanguageToggleSidebar(_props: PluginSidebarProps) {
  const [lang, setLangState] = useState<Lang>(() => readLang());

  // Pick up external changes (e.g. another tab) so the toggle stays in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLangState(readLang());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isKo = lang === "ko";
  const handleClick = () => {
    const next: Lang = isKo ? "en" : "ko";
    setLang(next);
    setLangState(next);
  };

  return (
    <button
      onClick={handleClick}
      title={isKo ? "Switch to English" : "한국어로 전환"}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md w-full text-foreground/80 hover:bg-accent/50 hover:text-foreground"
      style={{ background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
    >
      <span aria-hidden="true" style={{ width: 16, textAlign: "center" }}>🌐</span>
      <span className="flex-1 truncate">
        {isKo ? "한국어" : "English"}
        <span style={{ marginLeft: 8, opacity: 0.5, fontSize: 11 }}>
          {isKo ? "→ EN" : "→ KO"}
        </span>
      </span>
    </button>
  );
}
