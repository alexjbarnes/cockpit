import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoWatcher } from "@/server/todo-watcher";

const SESSION_ID = "test-sid";

const mockHomedir = vi.hoisted(() => ({ current: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHomedir.current,
  };
});

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "tw-test-"));
  const claudeDir = join(root, ".claude");
  const todosDir = join(claudeDir, "todos");
  const tasksDir = join(claudeDir, "tasks", SESSION_ID);
  return { root, claudeDir, todosDir, tasksDir };
}

describe("TodoWatcher", () => {
  let sb: ReturnType<typeof createSandbox>;

  beforeEach(() => {
    sb = createSandbox();
    mockHomedir.current = sb.root;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sb.root, { recursive: true, force: true });
  });

  describe("readOnce", () => {
    it("returns empty array when todos and tasks dirs dont exist", () => {
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([]);
    });

    it("returns empty array when both dirs exist but are empty", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      mkdirSync(sb.tasksDir, { recursive: true });
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([]);
    });

    it("reads the newest todo file and normalizes entries", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      writeFileSync(
        join(sb.todosDir, `${SESSION_ID}-agent-0.json`),
        JSON.stringify([
          { content: "Task A", status: "completed" },
          { content: "Task B", status: "in_progress", activeForm: "Working on B" },
        ]),
      );
      writeFileSync(join(sb.todosDir, `${SESSION_ID}-agent-1.json`), JSON.stringify([{ content: "Task C", status: "pending" }]));
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([{ content: "Task C", status: "pending" }]);
    });

    it("filters todo entries missing content or status", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      writeFileSync(
        join(sb.todosDir, `${SESSION_ID}-agent-0.json`),
        JSON.stringify([
          { content: "Valid", status: "pending" },
          { content: "", status: "pending" },
          { status: "pending" },
          { content: "No status" },
          {},
        ]),
      );
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([{ content: "Valid", status: "pending" }]);
    });

    it("returns empty when todo JSON is not an array", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      writeFileSync(join(sb.todosDir, `${SESSION_ID}-agent-0.json`), JSON.stringify({ not: "an array" }));
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([]);
    });

    it("returns empty when todo file is malformed JSON", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      writeFileSync(join(sb.todosDir, `${SESSION_ID}-agent-0.json`), "not json");
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([]);
    });

    it("returns normalized tasks when no todo files exist", () => {
      mkdirSync(sb.tasksDir, { recursive: true });
      writeFileSync(
        join(sb.tasksDir, "task1.json"),
        JSON.stringify({ subject: "Task 1", status: "in_progress", activeForm: "Doing task 1" }),
      );
      writeFileSync(join(sb.tasksDir, "task2.json"), JSON.stringify({ description: "Task 2 desc", status: "completed" }));
      const w = new TodoWatcher(SESSION_ID, () => {});
      const result = w.readOnce();
      expect(result).toEqual([
        { content: "Task 1", status: "in_progress", activeForm: "Doing task 1" },
        { content: "Task 2 desc", status: "completed" },
      ]);
    });

    it("skips tasks with deleted status", () => {
      mkdirSync(sb.tasksDir, { recursive: true });
      writeFileSync(join(sb.tasksDir, "active.json"), JSON.stringify({ subject: "Active", status: "in_progress" }));
      writeFileSync(join(sb.tasksDir, "deleted.json"), JSON.stringify({ subject: "Deleted", status: "deleted" }));
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([{ content: "Active", status: "in_progress" }]);
    });

    it("falls back through subject to description to empty string", () => {
      mkdirSync(sb.tasksDir, { recursive: true });
      writeFileSync(join(sb.tasksDir, "a.json"), JSON.stringify({ subject: "subj", status: "pending" }));
      writeFileSync(join(sb.tasksDir, "b.json"), JSON.stringify({ description: "desc", status: "pending" }));
      writeFileSync(join(sb.tasksDir, "c.json"), JSON.stringify({ status: "pending" }));
      const w = new TodoWatcher(SESSION_ID, () => {});
      const result = w.readOnce();
      expect(result).toEqual([
        { content: "subj", status: "pending" },
        { content: "desc", status: "pending" },
        { content: "", status: "pending" },
      ]);
    });

    it("skips malformed task files and reads the rest", () => {
      mkdirSync(sb.tasksDir, { recursive: true });
      writeFileSync(join(sb.tasksDir, "good.json"), JSON.stringify({ subject: "Good", status: "in_progress" }));
      writeFileSync(join(sb.tasksDir, "bad.json"), "not json");
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([{ content: "Good", status: "in_progress" }]);
    });

    it("prioritizes todos over tasks when both exist", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      mkdirSync(sb.tasksDir, { recursive: true });
      writeFileSync(join(sb.todosDir, `${SESSION_ID}-agent-0.json`), JSON.stringify([{ content: "From todos", status: "pending" }]));
      writeFileSync(join(sb.tasksDir, "task.json"), JSON.stringify({ subject: "From tasks", status: "in_progress" }));
      const w = new TodoWatcher(SESSION_ID, () => {});
      expect(w.readOnce()).toEqual([{ content: "From todos", status: "pending" }]);
    });
  });

  describe("start and stop", () => {
    it("calls onUpdate with todos on start and cleans up on stop", () => {
      mkdirSync(sb.todosDir, { recursive: true });
      writeFileSync(join(sb.todosDir, `${SESSION_ID}-agent-0.json`), JSON.stringify([{ content: "A", status: "pending" }]));
      const onUpdate = vi.fn();
      const w = new TodoWatcher(SESSION_ID, onUpdate);
      w.start();
      expect(onUpdate).toHaveBeenCalledWith([{ content: "A", status: "pending" }]);
      w.stop();
      w.stop(); // idempotent
    });

    it("does not call onUpdate when no dirs exist (empty initial guard)", () => {
      const onUpdate = vi.fn();
      const w = new TodoWatcher(SESSION_ID, onUpdate);
      w.start();
      // reload skips onUpdate when merged is empty and lastJson is ""
      expect(onUpdate).not.toHaveBeenCalled();
      w.stop();
    });
  });
});
