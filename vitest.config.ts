import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // Playwright specs in tests/integration/ run via `npm run test:integration`,
    // not vitest. Excluding them here keeps them from being discovered.
    exclude: ["node_modules/**", "tests/integration/**"],
    coverage: {
      exclude: [
        // Test helpers (mock API server/builder) are exercised by their own
        // smoke tests but are not production source — keep them out of the
        // coverage gate so they neither count toward nor drag down the src
        // thresholds. Without this they get pulled in because server.test.ts
        // imports them.
        "tests/**",
        // Require real node-pty/OS-level PTY; covered by gated E2E tests
        "src/server/pty-session.ts",
        "src/server/pty-runtime.ts",
        "src/server/terminal-manager.ts",
        // Server-side singletons: just getter/setters, no logic to test
        "src/server/singleton.ts",
        // UI components require jsdom/happy-dom for meaningful coverage;
        // they're exercised by E2E tests and manual testing
        "src/components/**",
        "src/hooks/**",
        "src/app/**",
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
