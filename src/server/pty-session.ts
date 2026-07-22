import { existsSync, realpathSync, statSync } from "node:fs";
import { type IPty, spawn } from "node-pty";

const TEXT_TO_ENTER_DELAY_MS = 300;
// Pause between the "clear line" write and typing the text. Sent back-to-back they
// reach the CLI in one read and the REPL's paste detection occasionally inserts the
// \x15 (Ctrl-U/kill-line) literally instead of acting on it, leaving a leading NAK in
// the submitted prompt (logged to the transcript, ~1% of sends) that also defeats
// optimistic-bubble dedup and renders a duplicate user message. The pause makes the
// \x15 land as its own keystroke, processed as kill-line before any text arrives.
const CLEAR_TO_TEXT_DELAY_MS = 30;
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
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // Drop any inherited 1M-context override BEFORE applying the caller's env, so a
    // CLAUDE_CODE_DISABLE_1M_CONTEXT sitting in cockpit's own environment can't pin
    // every session to 200k and defeat a 1m pick. The caller sets it per-session
    // via opts.env (200k → "1"; 1m → absent), which is applied on top here.
    delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    // The interactive CLI interposes a resume picker ("❯ Resume from summary
    // (recommended)" / "Resume full session as-is") when the transcript is older
    // than 70 minutes and estimated above 100k tokens. Cockpit types keystrokes
    // blind, so the trailing Enter of the first send lands on that menu and
    // confirms the highlighted default, which executes /compact — the message is
    // swallowed and the session compacts (the "magic /compact" bug). Both
    // thresholds are env-overridable, so push them out of reach and the picker
    // never renders; cockpit always resumes the full session and drives
    // compaction itself.
    env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = "999999999";
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999";
    Object.assign(env, this.opts.env ?? {});

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
    await sleep(CLEAR_TO_TEXT_DELAY_MS);
    // Frame multi-line input as an explicit bracketed paste (\e[200~ … \e[201~) so the
    // REPL keeps every embedded newline as literal content. Written raw, a multi-line
    // burst races the REPL's heuristic paste detection and gets mis-submitted — most
    // often as "/compact" — losing the message and firing a compaction (this was the
    // reported bug). The claude REPL buffers everything between the markers into one
    // literal pasted key (verified in the 2.1.216 binary), so slash/newline parsing
    // never runs on it. Single-line text keeps the exact prior path, which the send
    // tests already prove works.
    pty.write(text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
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
