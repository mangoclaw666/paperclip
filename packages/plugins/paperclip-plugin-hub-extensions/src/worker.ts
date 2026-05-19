import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "hub-extensions";

/**
 * Worker is minimal — all UI talks directly to core REST APIs
 * (PATCH /api/companies/:id for prompt defaults,
 *  PATCH /api/companies/:id/external-source for source updates,
 *  POST  /api/companies/:id/open + /resync for actions).
 */
const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} worker ready`);
  },
  async onHealth() {
    return { status: "ok", message: "Hub Extensions plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
