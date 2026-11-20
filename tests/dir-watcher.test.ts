import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDirectories } from "@/server/dir-watcher";
import { armWatcher } from "./support/fs-watch";

function createSandbox() {
  return mkdtempSync(join(tmpdir(), "dirw-test-"));
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("dir-watcher", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fires listener when a file is created in a watched folder", async () => {
    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, [""], listener);

    await armWatcher(
      () => writeFileSync(join(sandbox, "test.txt"), `hello ${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("watches a nested folder when it is in the list", async () => {
    const sub = join(sandbox, "sub");
    mkdirSync(sub);

    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, ["sub"], listener);

    await armWatcher(
      () => writeFileSync(join(sub, "deep.txt"), `deep ${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("does not descend into a folder that is not in the list", async () => {
    const sub = join(sandbox, "sub");
    mkdirSync(sub);

    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, [""], listener);

    // Prove the root watch is live before judging the silence below.
    await armWatcher(
      () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );
    listener.mockClear();

    writeFileSync(join(sub, "deep.txt"), "not watched");
    await wait(800);

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("debounces rapid changes into a single callback", async () => {
    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, [""], listener);

    await armWatcher(
      () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );
    listener.mockClear();

    writeFileSync(join(sandbox, "a.txt"), "1");
    writeFileSync(join(sandbox, "b.txt"), "2");
    writeFileSync(join(sandbox, "c.txt"), "3");
    await wait(800);

    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("shares one watcher for callers watching the same folder", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = watchDirectories(sandbox, [""], listener1);
    const unsub2 = watchDirectories(sandbox, [""], listener2);

    await armWatcher(
      () => writeFileSync(join(sandbox, "shared.txt"), `data ${Date.now()}`),
      () => listener1.mock.calls.length > 0,
    );

    expect(listener2).toHaveBeenCalled();
    unsub1();
    unsub2();
  });

  it("stops watching after the last caller leaves", async () => {
    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, [""], listener);

    await armWatcher(
      () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );
    unsub();
    listener.mockClear();

    writeFileSync(join(sandbox, "after.txt"), "data");
    await wait(800);

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores folders outside the session directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "dirw-outside-"));
    try {
      const listener = vi.fn();
      const unsub = watchDirectories(sandbox, ["", "..", outside], listener);

      await armWatcher(
        () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
        () => listener.mock.calls.length > 0,
      );
      listener.mockClear();

      writeFileSync(join(outside, "secret.txt"), "outside");
      await wait(800);

      expect(listener).not.toHaveBeenCalled();
      unsub();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("tolerates a folder that does not exist", () => {
    const listener = vi.fn();
    const unsub = watchDirectories(sandbox, ["missing"], listener);
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("stops at the directory cap instead of watching an unbounded list", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // None of these exist, so each watch fails with ENOENT and nothing is
    // actually armed; the loop still has to stop at the cap.
    const dirs = Array.from({ length: 2_001 }, (_, i) => `missing-${i}`);
    const unsub = watchDirectories(sandbox, dirs, vi.fn());
    expect(log).toHaveBeenCalledWith(expect.stringContaining("watching the first 2000 folders"));
    unsub();
    log.mockRestore();
  });
});
