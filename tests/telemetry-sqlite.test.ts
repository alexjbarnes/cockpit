// Loading Node's built-in SQLite: a reason instead of a crash where it is
// missing, and only its own experimental warning silenced.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqlite } from "@/server/telemetry/sqlite";

describe("loadSqlite", () => {
  const original = process.emitWarning;
  afterEach(() => {
    process.emitWarning = original;
  });

  it("gives a reason, not a crash, where the module is missing or broken", () => {
    const missing = loadSqlite(() => undefined);
    expect(missing.sqlite).toBeNull();
    expect(missing.reason).toMatch(/needs Node 22\.13 or later/);
    expect(loadSqlite(() => ({ DatabaseSync: "not a class" })).sqlite).toBeNull();
    const broken = loadSqlite(() => {
      throw new Error("boom");
    });
    expect(broken).toEqual({ sqlite: null, reason: "Node's built-in SQLite failed to load: boom" });
    expect(
      loadSqlite(() => {
        throw "plain";
      }).reason,
    ).toMatch(/plain/);
  });

  it("drops only SQLite's experimental warning while loading, and restores emitWarning after, even on a throw", () => {
    const seen = vi.fn();
    process.emitWarning = seen as unknown as typeof process.emitWarning;
    const fake = { DatabaseSync: class {} };
    const loaded = loadSqlite(() => {
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      process.emitWarning(new Error("SQLite is an experimental feature"));
      process.emitWarning("Something else entirely", "DeprecationWarning");
      return fake;
    });
    expect(loaded.sqlite).toBe(fake);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith("Something else entirely", "DeprecationWarning");
    expect(process.emitWarning).toBe(seen);

    loadSqlite(() => {
      throw new Error("x");
    });
    expect(process.emitWarning).toBe(seen);
  });

  it("loads the real module on this Node, when it has one", () => {
    const real = loadSqlite();
    const hasBuiltin = typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === "function";
    if (hasBuiltin && real.sqlite) expect(typeof real.sqlite.DatabaseSync).toBe("function");
    else expect(real.reason).toBeTruthy();
  });
});
