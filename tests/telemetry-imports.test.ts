// Guard: SQLite stays out of every bundle but the telemetry worker's.
//
// The Next routes are bundled by webpack (and by Turbopack in dev), and they
// import the session manager's whole tree through @/server/singleton. Were any
// file in that tree to import the telemetry store at run time, the bundler
// would try to resolve node:sqlite, which Node 20 lacks and Turbopack may not
// know. So: the store's modules are imported at run time only by each other
// and by server.ts, and nothing names node:sqlite in an import at all (the
// loader finds it with process.getBuiltinModule).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const telemetryDir = path.join(root, "src/server/telemetry");
/** Modules that load SQLite or start the worker, directly or through each other. */
const STORE_MODULES = ["db", "sqlite", "worker", "worker-core", "store-client", "service"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Every module a file imports at run time: static imports that are not
 *  type-only, re-exports, dynamic imports and requires. */
function runtimeImports(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/gm)) {
    if (!m[2]) found.push(m[3]);
  }
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(m[1]);
  for (const m of text.matchAll(/(?<!typeof\s)\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]);
  return found;
}

function resolvesToStore(file: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) target = path.join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
  else return null;
  if (path.dirname(target) !== telemetryDir) return null;
  const name = path.basename(target).replace(/\.(ts|js)$/, "");
  return STORE_MODULES.includes(name) ? name : null;
}

describe("telemetry import boundaries", () => {
  const files = [...sourceFiles(path.join(root, "src")), path.join(root, "server.ts")];

  it("finds the files it is guarding", () => {
    expect(files.some((f) => f.endsWith("src/server/singleton.ts"))).toBe(true);
    expect(runtimeImports('import type { A } from "./x";\nimport { B } from "./y";\nconst m = require("./z");')).toEqual(["./y", "./z"]);
  });

  it("imports the store's modules at run time only from server.ts and the telemetry folder", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.startsWith(telemetryDir + path.sep)) continue;
      for (const spec of runtimeImports(readFileSync(file, "utf-8"))) {
        const module = resolvesToStore(file, spec);
        if (!module) continue;
        if (file === path.join(root, "server.ts") && module === "service") continue;
        offenders.push(`${path.relative(root, file)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never names node:sqlite in an import", () => {
    const offenders = files.filter((file) => runtimeImports(readFileSync(file, "utf-8")).includes("node:sqlite"));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
