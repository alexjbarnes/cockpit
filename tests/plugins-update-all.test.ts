// Bulk plugin updates: each one fetches from its marketplace source, so they run
// one at a time and the page reports which of them failed.
import { beforeEach, describe, expect, it, vi } from "vitest";

let execFileCalls: { args: string[] }[] = [];
/** Keyed by the arguments after `plugin`, so a test can fail one plugin only. */
let execFileResults: Map<string, { err?: Error; stdout?: string; stderr?: string }> = new Map();
let execFileDefault: { err?: Error; stdout?: string; stderr?: string } = { stdout: "" };

vi.mock("node:child_process", () => {
  const record = (args: string[]) => {
    execFileCalls.push({ args });
    const key = args.join(" ");
    for (const [pattern, result] of execFileResults) {
      if (key.includes(pattern)) return result;
    }
    return execFileDefault;
  };
  const finish = (result: { err?: Error; stdout?: string; stderr?: string }) => {
    if (result.err) {
      Object.assign(result.err, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
      throw result.err;
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const execFile = (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const result = record(args);
    cb(result.err ?? null, result.stdout ?? "", result.stderr ?? "");
  };
  Object.assign(execFile, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (_cmd: string, args: string[]) => finish(record(args)),
  });
  return { execFile };
});

vi.mock("@/server/claude-bin", () => ({ getClaudeBin: () => "claude" }));

import { listInstalledPlugins, updateAllPlugins } from "@/server/plugins";

describe("listInstalledPlugins", () => {
  beforeEach(() => {
    execFileCalls = [];
    execFileResults = new Map();
    execFileDefault = { stdout: "[]" };
  });

  it("lists installed plugins without fetching the marketplace catalog", async () => {
    execFileDefault = { stdout: JSON.stringify([{ id: "a@m", version: "1", scope: "user", enabled: true, installPath: "/p" }]) };

    const plugins = await listInstalledPlugins();

    expect(execFileCalls[0].args).toEqual(["plugin", "list", "--json"]);
    expect(plugins.map((p) => p.id)).toEqual(["a@m"]);
  });
});

describe("updateAllPlugins", () => {
  beforeEach(() => {
    execFileCalls = [];
    execFileResults = new Map();
    execFileDefault = { stdout: "updated" };
  });

  it("updates every installed plugin, one at a time", async () => {
    execFileResults.set("plugin list --json", {
      stdout: JSON.stringify([
        { id: "a@m", version: "1" },
        { id: "b@m", version: "2" },
      ]),
    });

    const results = await updateAllPlugins();

    expect(results).toEqual([
      { id: "a@m", ok: true, message: "updated" },
      { id: "b@m", ok: true, message: "updated" },
    ]);
    expect(execFileCalls.map((c) => c.args)).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "update", "a@m"],
      ["plugin", "update", "b@m"],
    ]);
  });

  it("takes the ids it is given without listing them first", async () => {
    await updateAllPlugins(["a@m"]);

    expect(execFileCalls.map((c) => c.args)).toEqual([["plugin", "update", "a@m"]]);
  });

  it("keeps going after one plugin fails, and reports why", async () => {
    execFileResults.set("update a@m", { err: new Error("exit 1"), stderr: "could not fetch marketplace" });

    const results = await updateAllPlugins(["a@m", "b@m"]);

    expect(results).toEqual([
      { id: "a@m", ok: false, message: "could not fetch marketplace" },
      { id: "b@m", ok: true, message: "updated" },
    ]);
  });
});
