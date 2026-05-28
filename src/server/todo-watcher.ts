import { existsSync, type FSWatcher, readdirSync, readFileSync, unwatchFile, watch, watchFile } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "@/server/paths";
import type { TodoItem } from "@/types";

const DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 1000;

/**
 * Watches both ~/.claude/todos/<sessionId>-agent-*.json (TodoWrite) and
 * ~/.claude/tasks/<sessionId>/*.json (TaskCreate/TaskUpdate) for changes,
 * normalizes them to TodoItem[], and calls onUpdate when the list changes.
 */
export class TodoWatcher {
  private watchers: FSWatcher[] = [];
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastJson = "";
  private stopped = false;
  private readonly todosDir: string;
  private readonly tasksDir: string;

  constructor(
    private readonly cliSessionId: string,
    private readonly onUpdate: (todos: TodoItem[]) => void,
  ) {
    const base = getClaudeDir();
    this.todosDir = join(base, "todos");
    this.tasksDir = join(base, "tasks", cliSessionId);
  }

  start(): void {
    this.watchDir(this.todosDir);
    this.watchDir(this.tasksDir);
    this.reload();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    if (this.polling) {
      try {
        unwatchFile(this.todosDir);
      } catch {
        /* noop */
      }
      try {
        unwatchFile(this.tasksDir);
      } catch {
        /* noop */
      }
      this.polling = false;
    }
  }

  private watchDir(dir: string): void {
    if (!existsSync(dir)) {
      this.pollDir(dir);
      return;
    }
    try {
      const w = watch(dir, () => this.scheduleReload());
      this.watchers.push(w);
    } catch {
      this.pollDir(dir);
    }
  }

  private pollDir(dir: string): void {
    this.polling = true;
    watchFile(dir, { interval: POLL_INTERVAL_MS }, () => {
      if (this.stopped) return;
      if (existsSync(dir)) {
        unwatchFile(dir);
        try {
          const w = watch(dir, () => this.scheduleReload());
          this.watchers.push(w);
        } catch {
          /* stay on poll */
        }
      }
      this.scheduleReload();
    });
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), DEBOUNCE_MS);
  }

  readOnce(): TodoItem[] {
    const todos = this.readTodos();
    const tasks = this.readTasks();
    return todos.length > 0 ? todos : tasks;
  }

  private reload(): void {
    const todos = this.readTodos();
    const tasks = this.readTasks();
    const merged = todos.length > 0 ? todos : tasks;
    if (merged.length === 0 && this.lastJson === "") return;
    const json = JSON.stringify(merged);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.onUpdate(merged);
    }
  }

  private readTodos(): TodoItem[] {
    try {
      if (!existsSync(this.todosDir)) return [];
      const prefix = `${this.cliSessionId}-agent-`;
      const files = readdirSync(this.todosDir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
      if (files.length === 0) return [];
      const latest = files.sort().pop()!;
      const raw = JSON.parse(readFileSync(join(this.todosDir, latest), "utf-8"));
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((t: Record<string, unknown>) => t.content && t.status)
        .map((t: Record<string, unknown>) => ({
          content: t.content as string,
          status: t.status as TodoItem["status"],
          activeForm: (t.activeForm as string) || undefined,
        }));
    } catch {
      return [];
    }
  }

  private readTasks(): TodoItem[] {
    try {
      if (!existsSync(this.tasksDir)) return [];
      const files = readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));
      if (files.length === 0) return [];
      const tasks: TodoItem[] = [];
      for (const file of files) {
        try {
          const raw = JSON.parse(readFileSync(join(this.tasksDir, file), "utf-8"));
          if (raw.status === "deleted") continue;
          tasks.push({
            content: (raw.subject as string) || (raw.description as string) || "",
            status: mapTaskStatus(raw.status as string),
            activeForm: (raw.activeForm as string) || undefined,
          });
        } catch {
          // skip malformed file
        }
      }
      return tasks;
    } catch {
      return [];
    }
  }
}

function mapTaskStatus(status: string): TodoItem["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}
