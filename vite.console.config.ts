import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Independent output directory: building the monitor cannot replace production UI assets.
export default defineConfig({ root: resolve(__dirname, "src/ui"), plugins: [react()], base: "/console/",
  build: { outDir: resolve(__dirname, "dist-console"), emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/ui/monitor-app.html") } } });
