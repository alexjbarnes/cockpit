import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["node_modules/**"],
    coverage: {
      exclude: [
        // Require real node-pty/OS-level PTY; covered by gated E2E tests
        "src/server/pty-session.ts",
        "src/server/pty-runtime.ts",
        "src/server/terminal-manager.ts",
        // Server-side singletons: just getter/setters, no logic to test
        "src/server/singleton.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
