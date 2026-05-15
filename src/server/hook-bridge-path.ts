import { existsSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

/**
 * Resolve the absolute path to `bin/cockpit-hook-bridge.mjs`.
 *
 * cockpit always runs from its package root: in dev `tsx` runs from the repo
 * root; in prod `bin/cockpit.js` chdirs to the package root before importing
 * `dist/server.js`. So `bin/cockpit-hook-bridge.mjs` lives at
 * `process.cwd()/bin/cockpit-hook-bridge.mjs` in both cases.
 *
 * Allow override via COCKPIT_HOOK_BRIDGE_BIN for tests and packaging quirks.
 */
export function resolveHookBridgePath(): string {
  if (cached) return cached;

  const override = process.env.COCKPIT_HOOK_BRIDGE_BIN;
  if (override && existsSync(override)) {
    cached = override;
    return override;
  }

  const candidate = path.resolve(process.cwd(), "bin", "cockpit-hook-bridge.mjs");
  if (existsSync(candidate)) {
    cached = candidate;
    return candidate;
  }
  throw new Error(`cockpit-hook-bridge.mjs not found at ${candidate}`);
}
