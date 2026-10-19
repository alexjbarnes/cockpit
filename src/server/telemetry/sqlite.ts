/**
 * Loading Node's built-in SQLite. It exists from Node 22.13 without a flag and
 * not at all on Node 20, so it is looked up at run time rather than imported:
 * a Node without it gets a reason, not a crash. Going through
 * process.getBuiltinModule also keeps the module name out of every import
 * graph, so neither webpack nor Turbopack ever tries to resolve it.
 */

export type SqliteModule = typeof import("node:sqlite");

export type SqliteLoad = { sqlite: SqliteModule; reason?: undefined } | { sqlite: null; reason: string };

/** Node prints this on first load until the module leaves experimental. It is
 *  noise in cockpit's output, and the only warning this filter drops. */
const SQLITE_WARNING = /SQLite is an experimental feature/;

function defaultGetBuiltin(id: string): unknown {
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  return typeof get === "function" ? get.call(process, id) : undefined;
}

export function loadSqlite(getBuiltin: (id: string) => unknown = defaultGetBuiltin): SqliteLoad {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (typeof message === "string" && SQLITE_WARNING.test(message)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const mod = getBuiltin("node:sqlite") as SqliteModule | undefined;
    if (!mod || typeof mod.DatabaseSync !== "function") {
      return { sqlite: null, reason: `Node ${process.versions.node} has no built-in SQLite (it needs Node 22.13 or later)` };
    }
    return { sqlite: mod };
  } catch (err) {
    return { sqlite: null, reason: `Node's built-in SQLite failed to load: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    process.emitWarning = original;
  }
}
