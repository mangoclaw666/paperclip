import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "mangoclaw666.paperclip-plugin-workspace-bridge";
const PLUGIN_VERSION = "0.1.0";

const SLOT_EXTERNAL_SOURCE = "wb-external-source";
const SLOT_AGENT_PROMPTS = "wb-agent-prompts";
const SLOT_SIDEBAR_EXTERNAL = "wb-external-source-sidebar";
const SLOT_SIDEBAR_PROMPTS = "wb-agent-prompts-sidebar";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Workspace Bridge",
  description:
    "Bridge a Paperclip company to its on-disk source and inject company-wide agent prompts. Two pages today (External Source + Agent Prompts), with room for more workspace integration features.",
  author: "mangoclaw666",
  categories: ["ui"],
  capabilities: [
    "ui.page.register",
    "ui.sidebar.register",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_EXTERNAL_SOURCE,
        displayName: "External Source",
        exportName: "ExternalSourcePage",
        routePath: "workspace-bridge-external-source",
        order: 10,
      },
      {
        type: "page",
        id: SLOT_AGENT_PROMPTS,
        displayName: "Agent Prompts",
        exportName: "AgentPromptsPage",
        routePath: "workspace-bridge-agent-prompts",
        order: 11,
      },
      {
        type: "sidebar",
        id: SLOT_SIDEBAR_EXTERNAL,
        displayName: "External Source",
        exportName: "ExternalSourceSidebarLink",
        order: 100,
      },
      {
        type: "sidebar",
        id: SLOT_SIDEBAR_PROMPTS,
        displayName: "Agent Prompts",
        exportName: "AgentPromptsSidebarLink",
        order: 101,
      },
    ],
  },
};

export default manifest;
