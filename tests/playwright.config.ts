import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  use: {
    baseURL: "http://localhost:3099",
    headless: true,
    screenshot: "only-on-failure",
    trace: "off",
  },
  // We manage the web server manually in test setup (next dev + mock API)
  webServer: [],
});
