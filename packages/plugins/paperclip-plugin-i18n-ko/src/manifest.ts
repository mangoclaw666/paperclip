import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// fork_mangoclaw: Korean localization toggle. Provides a sidebar button to
// switch the UI between English and 한국어. The actual translation catalog
// lives in core (ui/src/i18n/locales/ko.json) — this plugin only owns the
// switch UX. Toggling fires a CustomEvent ("paperclip:i18n:setLanguage")
// that core App.tsx listens for and calls i18next.changeLanguage on.
const PLUGIN_ID = "mangoclaw666.paperclip-plugin-i18n-ko";
const PLUGIN_VERSION = "0.1.0";

const SLOT_SIDEBAR_TOGGLE = "i18n-ko-sidebar-toggle";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "한국어 (Korean)",
  description:
    "Toggle the PaperClip UI between English and 한국어. Persists choice to localStorage. Requires the core i18n key catalog (ko.json) to be populated.",
  author: "mangoclaw666",
  categories: ["ui"],
  capabilities: [
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SLOT_SIDEBAR_TOGGLE,
        displayName: "한국어 토글",
        exportName: "LanguageToggleSidebar",
        order: 90,
      },
    ],
  },
};

export default manifest;
