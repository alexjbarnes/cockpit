// Filming the tour: Chromium's screencast hands over a frame each time the page
// paints, stamped with when it painted, and ffmpeg turns those into a steady
// 30 fps H.264 file. Video time follows the wall clock while recording, so a
// still screen holds its frame for as long as it stayed still; pausing stops
// the clock, which is how a wait (a session restarting, a page loading) is cut
// out of the video.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

interface Frame {
  file: string;
  /** Seconds into the video. */
  t: number;
}

const wallNow = () => Date.now() / 1000;

export class Recorder {
  private cdp: CDPSession | null = null;
  private frames: Frame[] = [];
  private paused = false;
  /** Video time when the clock last started, and the wall time it started at. */
  private base = 0;
  private resumedAt = 0;
  /** How many seconds of wall time make one second of video. */
  private rate = 1;
  private end = 0;
  private count = 0;

  constructor(
    private page: Page,
    private dir: string,
    private size: { width: number; height: number },
  ) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  async start(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.resumedAt = wallNow();
    this.cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      if (this.paused) return;
      const wall = event.metadata.timestamp ?? wallNow();
      const t = Math.max(0, this.base + (wall - this.resumedAt) / this.rate);
      const last = this.frames[this.frames.length - 1];
      if (last && t <= last.t) return;
      const file = path.join(this.dir, `f${String(++this.count).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(event.data, "base64"));
      this.frames.push({ file, t });
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
  }

  /** Stop the clock until resume(); the time in between is not in the video. */
  pause(): void {
    if (this.paused) return;
    this.base = this.elapsed;
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.resumedAt = wallNow();
    this.paused = false;
  }

  /** Play what follows `rate` times faster, until set back to 1. */
  speed(rate: number): void {
    if (!this.paused) {
      this.base = this.elapsed;
      this.resumedAt = wallNow();
    }
    this.rate = rate;
  }

  async stop(): Promise<void> {
    this.end = this.elapsed;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
  }

  /** Video time so far, in seconds. */
  get elapsed(): number {
    return this.paused ? this.base : this.base + (wallNow() - this.resumedAt) / this.rate;
  }

  encode(ffmpeg: string, out: string, opts: { width: number; height: number }): void {
    if (!this.frames.length) throw new Error("no frames recorded");
    const lines: string[] = [];
    this.frames.forEach((f, i) => {
      const next = this.frames[i + 1];
      const until = next ? next.t : Math.max(this.end, f.t + 1 / 30);
      lines.push(`file '${f.file}'`, `duration ${Math.max(1 / 120, until - f.t).toFixed(4)}`);
    });
    // The concat demuxer ignores the last duration unless the file repeats.
    lines.push(`file '${this.frames[this.frames.length - 1].file}'`);
    const list = path.join(this.dir, "frames.txt");
    writeFileSync(list, `${lines.join("\n")}\n`);
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vf",
        `scale=${opts.width}:${opts.height}:flags=lanczos,format=yuv420p`,
        "-fps_mode",
        "cfr",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "20",
        "-tune",
        "animation",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: "inherit" },
    );
  }
}
