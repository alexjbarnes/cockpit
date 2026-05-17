// Test fixtures — provider config, temp directories, etc.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const COCKPIT_DIR = path.join(homedir(), ".cockpit");
const PROVIDERS_PATH = path.join(COCKPIT_DIR, "providers.json");

export const E2E_PROVIDER_ID = "e2e-test";
export const E2E_MODEL_ID = "claude-sonnet-4-6";
export const E2E_MODEL_STRING = `${E2E_PROVIDER_ID}:${E2E_MODEL_ID}`;
export const E2E_COCKPIT_TOKEN = "test-e2e-token";

let savedProviders: string | null = null;

export function setupTestProvider(mockApiPort: number): void {
  mkdirSync(COCKPIT_DIR, { recursive: true });

  if (existsSync(PROVIDERS_PATH)) {
    savedProviders = readFileSync(PROVIDERS_PATH, "utf-8");
  }

  const provider = {
    id: E2E_PROVIDER_ID,
    name: "E2E Test Mock",
    envVars: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockApiPort}`,
      ANTHROPIC_AUTH_TOKEN: "e2e-test-api-key",
    },
    models: [
      {
        modelId: E2E_MODEL_ID,
        displayName: "E2E Sonnet",
        effortLevels: ["low", "medium", "high"],
        supportsExtendedContext: false,
      },
    ],
    isBuiltin: false,
  };

  writeFileSync(PROVIDERS_PATH, JSON.stringify([provider], null, 2));
}

export function restoreProviders(): void {
  if (savedProviders !== null) {
    writeFileSync(PROVIDERS_PATH, savedProviders);
    savedProviders = null;
  } else if (existsSync(PROVIDERS_PATH)) {
    // Read current content; if it's just our test provider, remove the file
    try {
      const cur = JSON.parse(readFileSync(PROVIDERS_PATH, "utf-8"));
      if (Array.isArray(cur) && cur.length === 1 && cur[0].id === E2E_PROVIDER_ID) {
        const { unlinkSync } = require("node:fs");
        unlinkSync(PROVIDERS_PATH);
      }
    } catch {
      // leave as-is
    }
  }
}
