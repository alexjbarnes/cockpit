import { execSync } from "node:child_process";
import os from "node:os";
import { type IPty, spawn } from "node-pty";
import { v4 as uuidv4 } from "uuid";

import { appendToBuffer } from "./terminal-buffer";

function getLoginShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  try {
    const entry = execSync(`getent passwd ${os.userInfo().username}`, { encoding: "utf8" }).trim();
    const shell = entry.split(":").pop();
    if (shell) return shell;
  } catch {
    // getent not available (macOS)
  }
  try {
    const shell = execSync(`dscl . -read /Users/${os.userInfo().username} UserShell`, { encoding: "utf8" });
    const match = shell.match(/UserShell:\s*(.+)/);
    if (match) return match[1].trim();
  } catch {
    // not macOS
  }
  return process.env.SHELL || "/bin/bash";
}

interface TerminalInstance {
  id: string;
  pty: IPty;
  cwd: string;
  cols: number;
  rows: number;
  buffer: string;
  detachOffset: number;
  client: ((data: string) => void) | null;
}

export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();

  constructor() {
    setInterval(() => {
      for (const [id, term] of this.terminals) {
        try {
          process.kill(term.pty.pid, 0);
        } catch {
          this.terminals.delete(id);
        }
      }
    }, 15000);
  }

  createTerminal(cwd: string, shell?: string, cols = 120, rows = 40): string {
    const id = uuidv4();
    const resolvedShell = shell || getLoginShell();
    const pty = spawn(resolvedShell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });

    const instance: TerminalInstance = { id, pty, cwd, cols, rows, buffer: "", detachOffset: 0, client: null };
    this.terminals.set(id, instance);

    pty.onData((data: string) => {
      appendToBuffer(instance, data);
      if (instance.client) {
        instance.client(data);
      }
    });

    pty.onExit(() => {
      instance.client = null;
      this.terminals.delete(id);
    });

    return id;
  }

  attachClient(id: string, sendFn: (data: string) => void): boolean {
    const term = this.terminals.get(id);
    if (!term) return false;
    console.log(
      `[terminal] attachClient ${id.slice(0, 8)} buffer=${term.buffer.length}b detachOffset=${term.detachOffset} cols=${term.cols} rows=${term.rows}`,
    );
    term.client = sendFn;
    return true;
  }

  getBuffer(id: string): string {
    return this.terminals.get(id)?.buffer ?? "";
  }

  getDelta(id: string): string {
    const term = this.terminals.get(id);
    if (!term) return "";
    if (term.detachOffset >= term.buffer.length) return "";
    return term.buffer.slice(term.detachOffset);
  }

  detachClient(id: string, sendFn?: (data: string) => void): void {
    const term = this.terminals.get(id);
    if (!term) return;
    if (sendFn && term.client !== sendFn) return; // a newer client already attached; ignore this stale close
    term.detachOffset = term.buffer.length;
    term.client = null;
  }

  getTerminal(id: string): TerminalInstance | undefined {
    return this.terminals.get(id);
  }

  writeToTerminal(id: string, data: string): boolean {
    const term = this.terminals.get(id);
    if (!term) return false;
    term.pty.write(data);
    return true;
  }

  resizeTerminal(id: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(id);
    if (!term) return false;
    if (term.cols === cols && term.rows === rows) {
      console.log(`[terminal] resize ${id.slice(0, 8)} no-op (already ${cols}x${rows})`);
      return true;
    }
    const colsChanged = term.cols !== cols;
    console.log(
      `[terminal] resize ${id.slice(0, 8)} ${term.cols}x${term.rows} -> ${cols}x${rows}${colsChanged ? " (cols changed, clearing buffer)" : ""}`,
    );
    if (colsChanged) {
      term.buffer = "";
      term.detachOffset = 0;
    }
    term.pty.resize(cols, rows);
    term.cols = cols;
    term.rows = rows;
    return true;
  }

  destroyTerminal(id: string): boolean {
    const term = this.terminals.get(id);
    if (!term) return false;
    term.client = null;
    try {
      term.pty.kill();
    } catch {
      // already dead
    }
    this.terminals.delete(id);
    return true;
  }

  listTerminals(): Array<{ id: string; cwd: string }> {
    return Array.from(this.terminals.values()).map((t) => ({ id: t.id, cwd: t.cwd }));
  }
}
