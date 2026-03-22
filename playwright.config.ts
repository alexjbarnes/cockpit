import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3099",
    headless: true,
  },
  webServer: {
    command: "NODE_ENV=development COCKPIT_TOKEN=test-token PORT=3099 npx tsx server.ts",
    port: 3099,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NODE_ENV: "development",
      COCKPIT_TOKEN: "test-token",
      PORT: "3099",
    },
  },
});
