import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "server", include: ["server/**/*.test.ts"], environment: "node" } },
      {
        plugins: [react()],
        test: { name: "web", include: ["web/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["web/src/test-setup.ts"] },
      },
    ],
  },
});
