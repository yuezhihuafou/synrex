import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({ build: { ssr: resolve(__dirname, "scripts/console-monitor.ts"),
  outDir: resolve(__dirname, "dist-console-server"), emptyOutDir: true, target: "node22",
  rollupOptions: { output: { entryFileNames: "console-monitor.js" } } } });
