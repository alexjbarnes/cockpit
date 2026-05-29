import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // Reap any orphan cockpit/CLI processes before the suite (leftovers from a
  // previous run that died without teardown) and after it (this run's own
  // crashed/timed-out workers). See reap.ts.
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // One test at a time. The harness spawns a fresh cockpit per test; parallelism
  // would balloon resource use without buying much (CLI startup dominates).
  workers: 1,
  fullyParallel: false,
  // Per-test timeout covers harness boot (~10s) + spawn wait (5s) + test
  // body. 90s gives headroom for Next.js production server warmup.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    actionTimeout: 15_000,
    // Next.js production mode can be slow on the first request to each page
    // (route warmup). 30s allows for that without the test failing.
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // No global webServer block — each test gets its own cockpit instance via
  // the harness fixture, so each test owns its lifecycle.
});
