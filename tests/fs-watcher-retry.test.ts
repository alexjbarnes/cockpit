// A watcher that fails is re-armed, not abandoned: the page keeps its
// subscription, so dropping the watch silently stopped file updates until a
// reload re-subscribed. node:fs's watch is faked here; the debounce and retry
// timers are real code paths.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watchMock = vi.fn();
vi.mock("node:fs", () => ({
  watch: (...args: unknown[]) => watchMock(...args),
}));

import { watchCwd } from "@/server/fs-watcher";

type FakeWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };

function fakeWatcher(): FakeWatcher {
  const emitter = new EventEmitter() as FakeWatcher;
  emitter.close = vi.fn();
  return emitter;
}

describe("fs-watcher re-arming", () => {
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    watchMock.mockReset();
  });

  afterEach(() => {
    unsub?.();
    unsub = null;
    vi.useRealTimers();
  });

  it("retries when the watcher cannot be created, then fires listeners again", async () => {
    watchMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    const watcher = fakeWatcher();
    watchMock.mockImplementation(() => watcher);

    const listener = vi.fn();
    unsub = watchCwd("/probe/retry-create", listener);
    expect(watchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchMock).toHaveBeenCalledTimes(2);

    const onChange = watchMock.mock.calls[1][2] as (_event: string, filename: string) => void;
    onChange("change", "NOTE.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the watcher errors, keeping its listeners", async () => {
    const first = fakeWatcher();
    const second = fakeWatcher();
    watchMock.mockImplementationOnce(() => first).mockImplementation(() => second);

    const listener = vi.fn();
    unsub = watchCwd("/probe/retry-error", listener);

    first.emit("error", new Error("inotify broke"));
    expect(first.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchMock).toHaveBeenCalledTimes(2);

    const onChange = watchMock.mock.calls[1][2] as (_event: string, filename: string) => void;
    onChange("change", "NOTE.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not retry a directory that no longer exists", async () => {
    watchMock.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });

    unsub = watchCwd("/probe/retry-gone", vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchMock).toHaveBeenCalledTimes(1);
  });
});
