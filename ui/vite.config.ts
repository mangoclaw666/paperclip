import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        // Host pinned to 127.0.0.1 (not "localhost") because Node 18+ resolves
        // localhost to ::1 first, and the server only listens on IPv4 —
        // ECONNREFUSED → vite turns it into HTTP 500 on every /api call.
        // PAPERCLIP_API_PORT lets an isolated dev instance (e.g. 3200) be
        // reached without patching this file. Default stays 3100.
        target: `http://127.0.0.1:${process.env.PAPERCLIP_API_PORT ?? "3100"}`,
        ws: true,
      },
    },
  },
}));
