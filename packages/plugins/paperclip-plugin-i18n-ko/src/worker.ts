import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "i18n-ko";

// fork_mangoclaw: i18n-ko worker is intentionally minimal — the language
// toggle is entirely client-side (localStorage + CustomEvent). The worker
// only exists to satisfy the plugin framework's lifecycle expectations.
const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} worker ready`);
  },
  async onHealth() {
    return { status: "ok", message: "Korean localization toggle ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
