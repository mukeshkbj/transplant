import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
