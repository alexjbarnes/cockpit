import { existsSync, type FSWatcher, unwatchFile, watch, watchFile } from "node:fs";
import type { ChatMessage } from "@/types";
import { getTranscriptPath, loadTranscript } from "./transcript";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 500;

export class TranscriptWatcher {
  private watcher: FSWatcher | null = null;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSize = 0;
  private stopped = false;
  private readonly filePath: string;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly onUpdate: (messages: ChatMessage[], lastUsage: { used: number; total: number } | null) => void,
  ) {
    this.filePath = getTranscriptPath(sessionId, cwd);
  }

  start(): void {
    if (existsSync(this.filePath)) {
      this.watchWithInotify();
    } else {
      this.watchWithPoll();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.polling) {
      unwatchFile(this.filePath);
      this.polling = false;
    }
    await this.reload();
  }

  private watchWithInotify(): void {
    try {
      this.watcher = watch(this.filePath, () => this.scheduleReload());
    } catch {
      this.watchWithPoll();
    }
  }

  private watchWithPoll(): void {
    this.polling = true;
    watchFile(this.filePath, { interval: POLL_INTERVAL_MS }, () => {
      if (this.stopped) return;
      if (!this.watcher && existsSync(this.filePath)) {
        unwatchFile(this.filePath);
        this.polling = false;
        this.watchWithInotify();
      }
      this.scheduleReload();
    });
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), DEBOUNCE_MS);
  }

  private async reload(): Promise<void> {
    try {
      const result = await loadTranscript(this.sessionId, this.cwd, { tailLines: 150 });
      if (result.totalSize !== this.lastSize) {
        this.lastSize = result.totalSize;
        this.onUpdate(result.messages, result.lastUsage);
      }
    } catch {
      if (!this.stopped) {
        this.timer = setTimeout(() => this.reload(), 100);
      }
    }
  }
}
