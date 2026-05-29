import { existsSync, realpathSync, statSync } from "node:fs";
import { type IPty, spawn } from "node-pty";

const TEXT_TO_ENTER_DELAY_MS = 300;
const TRUST_DIALOG_WINDOW_MS = 5000;
const REPL_READY_MIN_BYTES = 100;
const REPL_READY_TIMEOUT_MS = 60_000;
const REPL_SETTLE_MS = 2000;

export interface PtySessionOptions {
  cwd: string;
  settingsPath: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  bin?: string;
  cols?: number;
  rows?: number;
  onData?: (chunk: string) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
}

export class PtySession {
  private pty: IPty | null = null;
  private buffer = "";
  private cols: number;
  private rows: number;
  private exited = false;
  private exitCode: number | null = null;
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
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const spawnFile = process.platform === "darwin" ? "/bin/zsh" : bin;
    const spawnArgs = process.platform === "darwin" ? ["-l", "-c", `exec ${[bin, ...args].map(shellQuote).join(" ")}`] : args;

    let diagInfo = `platform=${process.platform}, file=${spawnFile}, cwd=${this.opts.cwd}`;
    try {
      const exists = existsSync(spawnFile);
      diagInfo += `, exists=${exists}`;
      if (exists) {
        const real = realpathSync(spawnFile);
        const stat = statSync(real);
        const mode = `0${(stat.mode & 0o7777).toString(8)}`;
        diagInfo += `, realpath=${real}, mode=${mode}, size=${stat.size}`;
      }
    } catch (e) {
      diagInfo += `, diagError=${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(`[pty-session] spawn diagnostic: ${diagInfo}`);
    console.log(`[pty-session] spawn args: ${JSON.stringify(spawnArgs).slice(0, 500)}`);
    console.log(`[pty-session] PATH: ${env.PATH?.split(":").slice(0, 10).join(":")}`);

    try {
      this.pty = spawn(spawnFile, spawnArgs, {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: this.opts.cwd,
        env,
      });
    } catch (err) {
      console.error(`[pty-session] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[pty-session] full diagnostic: ${diagInfo}`);
      throw err;
    }

    this.pty.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > 64 * 1024) this.buffer = this.buffer.slice(-32 * 1024);
      this.opts.onData?.(data);
    });

    this.pty.onExit((info) => {
      this.exited = true;
      this.exitCode = info.exitCode;
      this.opts.onExit?.(info);
      this.pty = null;
    });

    await this.handleTrustDialog();
    await this.waitForReplReady();
  }

  async sendText(text: string): Promise<void> {
    const pty = this.requirePty();
    pty.write("\x15");
    pty.write(text);
    await sleep(TEXT_TO_ENTER_DELAY_MS);
    pty.write("\r");
  }

  sendSlash(command: string): void {
    const c = command.startsWith("/") ? command : `/${command}`;
    this.requirePty().write(`${c}\r`);
  }

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
      if (this.exited) return;
      const clean = this.cleanOutput();
      if (clean.includes("trust") || clean.includes("Yes,")) {
        this.requirePty().write("\r");
        accepted = true;
        break;
      }
      if (clean.length > REPL_READY_MIN_BYTES) break;
      await sleep(200);
    }
    if (accepted) await sleep(2000);
  }

  private async waitForReplReady(): Promise<void> {
    const deadline = Date.now() + REPL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(`claude exited during startup (code=${this.exitCode}, output=${this.cleanOutput().slice(0, 200)})`);
      }
      if (this.cleanOutput().length >= REPL_READY_MIN_BYTES) {
        await sleep(REPL_SETTLE_MS);
        if (this.exited) {
          throw new Error(`claude exited during startup (code=${this.exitCode}, output=${this.cleanOutput().slice(0, 200)})`);
        }
        return;
      }
      await sleep(200);
    }
    const clean = this.cleanOutput();
    throw new Error(
      `Timed out after ${REPL_READY_TIMEOUT_MS}ms waiting for claude REPL (got ${clean.length} bytes: ${clean.slice(0, 200)})`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(s: string): string {
  if (!/[\s"'\\$`!#&|;()<>]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
