import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCwd } from "@/server/fs-watcher";

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

    writeFileSync(join(sandbox, "test.txt"), "hello");
    await wait(800);

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("fires listener when a file is modified", async () => {
    writeFileSync(join(sandbox, "existing.txt"), "v1");
    await wait(100);

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    writeFileSync(join(sandbox, "existing.txt"), "v2");
    await wait(800);

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("fires listener for changes in subdirectories", async () => {
    const sub = join(sandbox, "sub");
    mkdirSync(sub);

    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

    writeFileSync(join(sub, "deep.txt"), "deep");
    await wait(800);

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("debounces rapid changes into a single callback", async () => {
    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);

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

    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main");
    await wait(800);

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("shares one watcher for multiple listeners on the same cwd", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = watchCwd(sandbox, listener1);
    const unsub2 = watchCwd(sandbox, listener2);

    writeFileSync(join(sandbox, "shared.txt"), "data");
    await wait(800);

    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();

    unsub1();
    unsub2();
  });

  it("stops watching after last listener unsubscribes", async () => {
    const listener = vi.fn();
    const unsub = watchCwd(sandbox, listener);
    unsub();

    writeFileSync(join(sandbox, "after.txt"), "data");
    await wait(800);

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps watching when one of multiple listeners unsubscribes", async () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = watchCwd(sandbox, listener1);
    const unsub2 = watchCwd(sandbox, listener2);

    unsub1();

    writeFileSync(join(sandbox, "still.txt"), "watching");
    await wait(800);

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();

    unsub2();
  });
});
