import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCwd } from "@/server/fs-watcher";
import { armWatcher } from "./support/fs-watch";

function createSandbox() {
  return mkdtempSync(join(tmpdir(), "fsw-test-"));
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("fs-watcher", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fires listener when a file is created", async () => {
    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    await armWatcher(
      () => writeFileSync(join(sandbox, "test.txt"), `hello ${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("fires listener when a file is modified", async () => {
    writeFileSync(join(sandbox, "existing.txt"), "v1");

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    await armWatcher(
      () => writeFileSync(join(sandbox, "existing.txt"), `v${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("fires listener for changes in subdirectories", async () => {
    const sub = join(sandbox, "sub");
    mkdirSync(sub);

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    await armWatcher(
      () => writeFileSync(join(sub, "deep.txt"), `deep ${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("debounces rapid changes into a single callback", async () => {
    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    // Arm on a throwaway file, then judge the debounce from a clean slate.
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

  it("ignores .git internal changes", async () => {
    const gitDir = join(sandbox, ".git", "objects");
    mkdirSync(gitDir, { recursive: true });

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    // Without arming first, a watcher that never started would make this pass
    // for the wrong reason — silence proves nothing until the watch is known
    // to be live.
    await armWatcher(
      () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );
    listener.mockClear();

    writeFileSync(join(gitDir, "abc123"), "object data");
    await wait(800);

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("does NOT ignore .git/HEAD changes", async () => {
    const gitDir = join(sandbox, ".git");
    mkdirSync(gitDir, { recursive: true });

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    await armWatcher(
      () => writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/main ${Date.now()}`),
      () => listener.mock.calls.length > 0,
    );

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("shares one watcher for multiple listeners on the same cwd", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = watchCwd(sandbox, listener1);
    const unsub2 = watchCwd(sandbox, listener2);

    await armWatcher(
      () => writeFileSync(join(sandbox, "shared.txt"), `data ${Date.now()}`),
      () => listener1.mock.calls.length > 0,
    );

    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();

    unsub1();
    unsub2();
  });

  it("stops watching after last listener unsubscribes", async () => {
    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    // Prove the watch was live before unsubscribing, so the silence below is
    // evidence the unsubscribe worked rather than that it never started.
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

  it("keeps watching when one of multiple listeners unsubscribes", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = watchCwd(sandbox, listener1);
    const unsub2 = watchCwd(sandbox, listener2);

    await armWatcher(
      () => writeFileSync(join(sandbox, "arm.txt"), `${Date.now()}`),
      () => listener2.mock.calls.length > 0,
    );
    unsub1();
    listener1.mockClear();
    listener2.mockClear();

    await armWatcher(
      () => writeFileSync(join(sandbox, "still.txt"), `watching ${Date.now()}`),
      () => listener2.mock.calls.length > 0,
    );

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();

    unsub2();
  });
});
