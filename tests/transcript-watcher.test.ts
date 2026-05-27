import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWatch = vi.fn();
const mockWatchFile = vi.fn();
const mockUnwatchFile = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: mockWatch,
    watchFile: mockWatchFile,
    unwatchFile: mockUnwatchFile,
    existsSync: mockExistsSync,
  };
});

const mockLoadTranscript = vi.fn();
const mockGetTranscriptPath = vi.fn().mockReturnValue("/tmp/test-transcript.jsonl");

vi.mock("@/server/transcript", () => ({
  loadTranscript: mockLoadTranscript,
  getTranscriptPath: mockGetTranscriptPath,
}));

describe("TranscriptWatcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockLoadTranscript.mockResolvedValue({ messages: [], totalSize: 0, lastUsage: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses inotify when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWatch.mockReturnValue({ close: vi.fn() });
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", vi.fn());
    watcher.start();
    expect(mockWatch).toHaveBeenCalled();
    expect(mockWatchFile).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("falls back to polling when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", vi.fn());
    watcher.start();
    expect(mockWatchFile).toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("falls back to polling when watch throws", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWatch.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", vi.fn());
    watcher.start();
    expect(mockWatchFile).toHaveBeenCalled();
    await watcher.stop();
  });

  it("debounces reload on change events", async () => {
    mockExistsSync.mockReturnValue(true);
    let changeCallback: () => void;
    mockWatch.mockImplementation((_path: string, cb: () => void) => {
      changeCallback = cb;
      return { close: vi.fn() };
    });
    const onUpdate = vi.fn();
    mockLoadTranscript.mockResolvedValue({ messages: [{ id: "1" }], totalSize: 100, lastUsage: null });
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", onUpdate);
    watcher.start();

    changeCallback!();
    changeCallback!();
    await vi.advanceTimersByTimeAsync(300);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("calls onUpdate when transcript size changes", async () => {
    mockExistsSync.mockReturnValue(true);
    let changeCallback: () => void;
    mockWatch.mockImplementation((_path: string, cb: () => void) => {
      changeCallback = cb;
      return { close: vi.fn() };
    });
    const onUpdate = vi.fn();
    const messages = [{ id: "1", role: "user" }];
    mockLoadTranscript.mockResolvedValue({ messages, totalSize: 500, lastUsage: { used: 10, total: 100 } });
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", onUpdate);
    watcher.start();

    changeCallback!();
    await vi.advanceTimersByTimeAsync(300);

    expect(onUpdate).toHaveBeenCalledWith(messages, { used: 10, total: 100 });
    await watcher.stop();
  });

  it("does not call onUpdate when size unchanged", async () => {
    mockExistsSync.mockReturnValue(true);
    let changeCallback: () => void;
    mockWatch.mockImplementation((_path: string, cb: () => void) => {
      changeCallback = cb;
      return { close: vi.fn() };
    });
    const onUpdate = vi.fn();
    mockLoadTranscript.mockResolvedValue({ messages: [], totalSize: 0, lastUsage: null });
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", onUpdate);
    watcher.start();

    changeCallback!();
    await vi.advanceTimersByTimeAsync(300);

    expect(onUpdate).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("retries on reload error", async () => {
    mockExistsSync.mockReturnValue(true);
    let changeCallback: () => void;
    mockWatch.mockImplementation((_path: string, cb: () => void) => {
      changeCallback = cb;
      return { close: vi.fn() };
    });
    mockLoadTranscript
      .mockRejectedValueOnce(new Error("read fail"))
      .mockResolvedValue({ messages: [{ id: "1" }], totalSize: 100, lastUsage: null });
    const onUpdate = vi.fn();
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", onUpdate);
    watcher.start();

    changeCallback!();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("stop cleans up watcher and unwatches poll", async () => {
    mockExistsSync.mockReturnValue(false);
    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", vi.fn());
    watcher.start();
    await watcher.stop();
    expect(mockUnwatchFile).toHaveBeenCalled();
  });

  it("poll callback upgrades to inotify when file appears", async () => {
    mockExistsSync.mockReturnValue(false);
    let pollCallback: () => void;
    mockWatchFile.mockImplementation((_path: string, _opts: unknown, cb: () => void) => {
      pollCallback = cb;
    });
    mockWatch.mockReturnValue({ close: vi.fn() });

    const { TranscriptWatcher } = await import("@/server/transcript-watcher");
    const watcher = new TranscriptWatcher("sess-1", "/tmp", vi.fn());
    watcher.start();

    mockExistsSync.mockReturnValue(true);
    pollCallback!();

    expect(mockUnwatchFile).toHaveBeenCalled();
    expect(mockWatch).toHaveBeenCalled();
    await watcher.stop();
  });
});
