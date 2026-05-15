import { type IPty, spawn } from "node-pty";

const TEXT_TO_ENTER_DELAY_MS = 300;
const TRUST_DIALOG_WINDOW_MS = 8000;
const REPL_READY_MIN_BYTES = 800;
const REPL_READY_TIMEOUT_MS = 30_000;
const REPL_SETTLE_MS = 3000;

export interface PtySessionOptions {
  cwd: string;
  settingsPath: string;
  /** Env vars in addition to process.env. Cockpit hook bridge needs COCKPIT_HOOK_* set here. */
  env?: Record<string, string>;
  /** Extra args passed to claude after --verbose --settings <path>. */
  extraArgs?: string[];
  /** Override which claude binary to spawn (defaults to `claude`). */
  bin?: string;
  cols?: number;
  rows?: number;
  /** Called with every PTY data chunk. Used for debug logging; cockpit otherwise discards output. */
  onData?: (chunk: string) => void;
  /** Called when the PTY process exits. */
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

/**
 * Wraps a `claude --verbose` PTY process. Output is consumed only enough to
 * detect the initial trust prompt and the REPL-ready state; structured data
 * arrives via the hook router, not by parsing the TUI.
 */
export class PtySession {
  private pty: IPty | null = null;
  private buffer = "";
  private cols: number;
  private rows: number;
  private readonly opts: PtySessionOptions;

  constructor(opts: PtySessionOptions) {
    this.opts = opts;
    this.cols = opts.cols ?? 160;
    this.rows = opts.rows ?? 50;
  }

  get pid(): number {
    return this.pty?.pid ?? -1;
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error("PtySession already started");

    const bin = this.opts.bin ?? "claude";
    const args = ["--verbose", "--settings", this.opts.settingsPath, ...(this.opts.extraArgs ?? [])];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(this.opts.env ?? {}),
    };
    // Strip auto-detect markers so claude classifies this as interactive (cli).
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    this.pty = spawn(bin, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.opts.cwd,
      env,
    });

    this.pty.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > 64 * 1024) this.buffer = this.buffer.slice(-32 * 1024);
      this.opts.onData?.(data);
    });

    this.pty.onExit((info) => {
      this.opts.onExit?.(info);
      this.pty = null;
    });

    await this.handleTrustDialog();
    await this.waitForReplReady();
  }

  /** Type a message and submit it via Enter. */
  async sendText(text: string): Promise<void> {
    this.requirePty().write(text);
    await sleep(TEXT_TO_ENTER_DELAY_MS);
    this.requirePty().write("\r");
  }

  /** Submit a slash command (no inter-character delay needed). */
  sendSlash(command: string): void {
    const c = command.startsWith("/") ? command : `/${command}`;
    this.requirePty().write(`${c}\r`);
  }

  /** Send a raw key or escape sequence (e.g. "\x1b" for Esc). */
  sendKey(key: string): void {
    this.requirePty().write(key);
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.pty) return;
    try {
      this.pty.kill(signal);
    } catch {
      // already dead
    }
    this.pty = null;
  }

  private requirePty(): IPty {
    if (!this.pty) throw new Error("PtySession not started or already exited");
    return this.pty;
  }

  private cleanOutput(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
    const ansi = /\x1b\[[0-9;]*[a-zA-Z]/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI extras
    const extras = /\x1b[>=?][^\x1b]*/g;
    return this.buffer.replace(ansi, "").replace(extras, "");
  }

  private async handleTrustDialog(): Promise<void> {
    const deadline = Date.now() + TRUST_DIALOG_WINDOW_MS;
    let accepted = false;
    while (Date.now() < deadline) {
      const clean = this.cleanOutput();
      if (clean.includes("trust") || clean.includes("Yes,")) {
        this.requirePty().write("\r");
        accepted = true;
        break;
      }
      if (clean.length > REPL_READY_MIN_BYTES) break;
      await sleep(200);
    }
    if (accepted) await sleep(3000);
  }

  private async waitForReplReady(): Promise<void> {
    const deadline = Date.now() + REPL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.cleanOutput().length >= REPL_READY_MIN_BYTES) {
        await sleep(REPL_SETTLE_MS);
        return;
      }
      await sleep(200);
    }
    throw new Error(`Timed out after ${REPL_READY_TIMEOUT_MS}ms waiting for claude REPL to be ready`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
