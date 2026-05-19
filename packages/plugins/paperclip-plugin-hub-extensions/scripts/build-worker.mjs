import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

// Bundle the worker including all workspace-linked deps (@paperclipai/plugin-sdk,
// @paperclipai/shared, etc) into a single self-contained .js file. Plugin worker
// runs under plain `node`, which can't resolve TypeScript-source exports that
// workspace packages expose during development. Bundling sidesteps that entirely.
await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/worker.ts")],
  outfile: path.join(packageRoot, "dist/worker.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  sourcemap: true,
  // Keep Node built-ins external; bundle everything else.
  packages: undefined,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
