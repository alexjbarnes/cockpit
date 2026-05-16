import { existsSync, type FSWatcher, unwatchFile, watch, watchFile } from "node:fs";
import type { ChatMessage } from "@/types";
import { getTranscriptPath, loadTranscript } from "./transcript";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 500;

export class TranscriptWatcher {
  private watcher: FSWatcher | null = null;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCount = 0;
  private stopped = false;
  private readonly filePath: string;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly onUpdate: (messages: ChatMessage[]) => void,
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
      const count = result.messages.length;
      const changed =
        count !== this.lastCount || (count > 0 && result.messages[count - 1].blocks.length !== this.lastBlockCount(result.messages));
      if (changed) {
        this.lastCount = count;
        this.onUpdate(result.messages);
      }
    } catch {
      // file may be mid-write; next tick will catch up
    }
  }

  private _lastBlockLen = 0;
  private lastBlockCount(messages: ChatMessage[]): number {
    const last = messages[messages.length - 1];
    const len = last?.blocks?.length ?? 0;
    const prev = this._lastBlockLen;
    this._lastBlockLen = len;
    return prev;
  }
}
