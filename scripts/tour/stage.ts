// The tour's camera operator: moves the pointer the way a hand would (eased,
// at a readable speed), clicks with a ripple, types at a human pace, and puts
// captions and title cards on screen. The pointer follows the real mouse, so
// hover styles and the drawn pointer always agree.

import type { Locator, Page } from "playwright";
import type { Recorder } from "./capture";

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Stage {
  private x = 640;
  private y = 420;

  constructor(
    readonly page: Page,
    readonly rec: Recorder,
  ) {}

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Puts the pointer back after a page load (a new document draws a new one). */
  async restorePointer(): Promise<void> {
    await this.page.evaluate(
      ([x, y]) => (window as unknown as { __tour: { at(x: number, y: number): void } }).__tour?.at(x, y),
      [this.x, this.y],
    );
    await this.page.mouse.move(this.x, this.y);
  }

  async glide(x: number, y: number, ms?: number): Promise<void> {
    const distance = Math.hypot(x - this.x, y - this.y);
    const duration = ms ?? Math.min(750, Math.max(280, distance * 0.85));
    const from = { x: this.x, y: this.y };
    const start = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - start) / duration);
      const k = ease(t);
      await this.page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      if (t >= 1) break;
      await this.wait(12);
    }
    this.x = x;
    this.y = y;
  }

  async box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`no box for ${target}`);
    return box;
  }

  async glideTo(target: Locator, opts: { ms?: number; dx?: number; dy?: number } = {}): Promise<void> {
    const b = await this.box(target);
    await this.glide(b.x + b.width / 2 + (opts.dx ?? 0), b.y + b.height / 2 + (opts.dy ?? 0), opts.ms);
  }

  async click(target: Locator, opts: { ms?: number; dx?: number; dy?: number; settle?: number } = {}): Promise<void> {
    await this.glideTo(target, opts);
    await this.wait(110);
    await this.page.mouse.down();
    await this.wait(60);
    await this.page.mouse.up();
    await this.wait(opts.settle ?? 300);
  }

  async type(text: string, delay = 32): Promise<void> {
    await this.page.keyboard.type(text, { delay });
  }

  /** Scrolls whatever is under the pointer, smoothly. */
  async scroll(dy: number, ms = 900, dx = 0): Promise<void> {
    const steps = Math.max(1, Math.round(ms / 16));
    let done = 0;
    let doneX = 0;
    for (let i = 1; i <= steps; i++) {
      const target = dy * ease(i / steps);
      const targetX = dx * ease(i / steps);
      await this.page.mouse.wheel(targetX - doneX, target - done);
      done = target;
      doneX = targetX;
      await this.wait(16);
    }
  }

  private tour<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      ([name, rest]) => {
        const t = (window as unknown as { __tour?: Record<string, (...a: unknown[]) => unknown> }).__tour;
        t?.mount?.();
        return t?.[name as string]?.(...(rest as unknown[])) as T;
      },
      [fn, args] as const,
    );
  }

  caption(title: string, sub?: string, where: "bottom" | "top" = "bottom"): Promise<void> {
    return this.tour("caption", title, sub ?? "", where);
  }

  hideCaption(): Promise<void> {
    return this.tour("hideCaption");
  }

  card(html: string): Promise<void> {
    return this.tour("card", html);
  }

  hideCard(): Promise<void> {
    return this.tour("hideCard");
  }

  touch(on: boolean): Promise<void> {
    return this.tour("touch", on);
  }

  hidePointer(hidden: boolean): Promise<void> {
    return this.tour("hideCursor", hidden);
  }

  /** A tap at a point, for the phone scene: the drawn touch marks it. */
  async tap(target: Locator): Promise<void> {
    const b = await this.box(target);
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await this.tour("at", x, y);
    await this.wait(250);
    await this.tour("tap", x, y);
    await this.page.mouse.click(x, y);
    this.x = x;
    this.y = y;
    await this.wait(350);
  }

  /** Plays whatever `fn` waits for (Claude working, say) `rate` times faster. */
  async fast<T>(rate: number, fn: () => Promise<T>): Promise<T> {
    this.rec.speed(rate);
    try {
      return await fn();
    } finally {
      this.rec.speed(1);
    }
  }

  /** Leaves out of the video whatever `fn` waits for. */
  async cut<T>(fn: () => Promise<T>): Promise<T> {
    this.rec.pause();
    try {
      return await fn();
    } finally {
      this.rec.resume();
      // A still page sends no frame, so nudge the pointer to start the next shot.
      await this.page.mouse.move(this.x + 1, this.y);
      await this.page.mouse.move(this.x, this.y);
    }
  }

  /** A short dip to dark and back, around a change that is cut out. */
  async dip<T>(fn: () => Promise<T>): Promise<T> {
    await this.card("");
    await this.wait(650);
    const result = await this.cut(async () => {
      const r = await fn();
      // A new document starts without the dark card: bring it up off camera.
      await this.restorePointer();
      await this.card("");
      await this.wait(700);
      return r;
    });
    await this.hideCard();
    await this.wait(550);
    return result;
  }
}
