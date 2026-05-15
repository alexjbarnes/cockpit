import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Resolve the absolute path to `bin/cockpit-hook-bridge.mjs`.
 *
 * In dev: `server.ts` runs from the repo root, so `bin/` is a sibling.
 * In prod: `dist/server.js` runs from `<pkg>/dist/`, so `bin/` is one level up.
 * Allow override via COCKPIT_HOOK_BRIDGE_BIN for tests and packaging quirks.
 */
export function resolveHookBridgePath(): string {
  if (cached) return cached;

  const override = process.env.COCKPIT_HOOK_BRIDGE_BIN;
  if (override && existsSync(override)) {
    cached = override;
    return override;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "..", "bin", "cockpit-hook-bridge.mjs"),
    path.resolve(here, "..", "..", "bin", "cockpit-hook-bridge.mjs"),
    path.resolve(here, "..", "bin", "cockpit-hook-bridge.mjs"),
    path.resolve(process.cwd(), "bin", "cockpit-hook-bridge.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cached = c;
      return c;
    }
  }
  throw new Error(`cockpit-hook-bridge.mjs not found. Searched: ${candidates.join(", ")}`);
}
