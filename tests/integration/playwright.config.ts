import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // One test at a time. The harness spawns a fresh cockpit per test; parallelism
  // would balloon resource use without buying much (CLI startup dominates).
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // No global webServer block — each test gets its own cockpit instance via
  // the harness fixture, so each test owns its lifecycle.
});
