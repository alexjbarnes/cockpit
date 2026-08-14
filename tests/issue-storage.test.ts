// Unit tests for the file-based issue/project store. Exercises the CRUD,
// key-allocation and activity-logging functions against a real tmpdir via
// COCKPIT_CONFIG_DIR (getCockpitDir reads the env var per call, so no fs
// mocking is needed), mirroring tests/job-storage.test.ts's isolation
// convention.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueStatusChangeEvent } from "@/server/issue-events";
import { onIssueStatusChange } from "@/server/issue-events";
import {
  addIssueAttachment,
  addIssueComment,
  applyIssueUpdate,
  applyProjectUpdate,
  buildIssue,
  buildProject,
  deleteIssue,
  deleteProject,
  getIssue,
  getProject,
  loadIssues,
  loadProjects,
  nextKey,
  persistAttachmentFile,
  saveIssue,
  saveProject,
} from "@/server/issue-storage";
import { getIssueAttachmentsRoot } from "@/server/paths";
import type { Issue, IssueActor, Project } from "@/types";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-issuestore-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(prefix: string, overrides: Partial<Project> = {}): Project {
  const project = buildProject({ name: `Project ${prefix}`, prefix, ...overrides });
  saveProject(project);
  return project;
}

const USER: IssueActor = { kind: "user" };

describe("projects: build / save / load", () => {
  it("loadProjects returns [] when no file exists yet", () => {
    expect(loadProjects()).toEqual([]);
  });

  it("buildProject assigns id/timestamps/nextNumber and defaults archived to false", () => {
    const p = buildProject({ name: "Cockpit", prefix: "CK" });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("Cockpit");
    expect(p.nextNumber).toBe(1);
    expect(p.archived).toBe(false);
    expect(p.createdAt).toBe(p.updatedAt);
  });

  it("buildProject respects an explicit archived: true instead of defaulting it", () => {
    expect(buildProject({ name: "Cockpit", prefix: "CK", archived: true }).archived).toBe(true);
  });

  it("saveProject inserts a new project and getProject/loadProjects read it back", () => {
    const p = makeProject("CK");
    expect(loadProjects()).toHaveLength(1);
    expect(getProject(p.id)?.name).toBe("Project CK");
  });

  it("saveProject updates an existing project in place (no duplicate)", () => {
    const p = makeProject("CK");
    saveProject({ ...p, name: "Renamed" });
    const all = loadProjects();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  describe("prefix normalisation and uniqueness", () => {
    it("buildProject uppercases the prefix", () => {
      const p = buildProject({ name: "Cockpit", prefix: "ck" });
      expect(p.prefix).toBe("CK");
    });

    it("saveProject uppercases the prefix even for a hand-built object that bypassed buildProject", () => {
      const p = buildProject({ name: "Cockpit", prefix: "CK" });
      saveProject({ ...p, prefix: "xy" });
      expect(getProject(p.id)?.prefix).toBe("XY");
    });

    it("buildProject itself now rejects an empty/blank prefix (moved earlier by the value-validation fix)", () => {
      // This test used to construct the invalid Project via buildProject and
      // rely on saveProject to reject it — that was the only check that
      // existed. buildProject now validates name/prefix itself (closing the
      // "one construction path controls fields, not values" gap), so it
      // throws right here, before saveProject is ever reached; the case
      // below covers saveProject's own belt-and-braces check separately, for
      // a caller that bypasses buildProject entirely.
      expect(() => buildProject({ name: "Cockpit", prefix: "   " })).toThrow(/prefix must be a non-empty string/i);
    });

    it("saveProject still rejects an empty/blank prefix on a hand-built object that bypassed buildProject", () => {
      const p = buildProject({ name: "Cockpit", prefix: "CK" });
      expect(() => saveProject({ ...p, prefix: "   " })).toThrow(/prefix must not be empty/i);
    });

    it("rejects a prefix already used by a different project, case-insensitively", () => {
      makeProject("CK");
      const other = buildProject({ name: "Clone", prefix: "ck" });
      expect(() => saveProject(other)).toThrow(/already used/i);
      expect(loadProjects()).toHaveLength(1);
    });

    it("allows re-saving the same project under its own unchanged prefix", () => {
      const p = makeProject("CK");
      expect(() => saveProject({ ...p, description: "updated" })).not.toThrow();
      expect(getProject(p.id)?.description).toBe("updated");
    });
  });

  describe("prefix immutability once a project has issues (regression)", () => {
    it("rejects a prefix change once the project has at least one issue, and leaves everything untouched", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER)); // CK-1

      const renamed = applyProjectUpdate(getProject(p.id)!, { prefix: "RO" });
      expect(() => saveProject(renamed)).toThrow(/prefix/i);

      // The exact symptoms the coordinator measured must all be absent now:
      // the project keeps its prefix, the issue is still reachable under its
      // original key, no phantom key exists under the rejected prefix, and
      // the counter never advanced past an unused number.
      expect(getProject(p.id)?.prefix).toBe("CK");
      expect(getIssue("CK-1")?.title).toBe("t");
      expect(getIssue("RO-1")).toBeUndefined();
      expect(nextKey(p.id)).toBe("CK-2");
    });

    it("still allows changing the prefix of a project that has no issues yet", () => {
      const p = makeProject("CK");
      const renamed = applyProjectUpdate(p, { prefix: "RO" });
      expect(() => saveProject(renamed)).not.toThrow();
      expect(getProject(p.id)?.prefix).toBe("RO");
    });

    it("allows re-saving with the same prefix (just different case) even once issues exist, since nothing is actually changing", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));

      const same = applyProjectUpdate(getProject(p.id)!, { prefix: "ck", description: "updated" });
      expect(() => saveProject(same)).not.toThrow();
      expect(getProject(p.id)?.description).toBe("updated");
      expect(getProject(p.id)?.prefix).toBe("CK");
    });

    it("rejects the change even when deleting/re-adding issues would make it tempting: any issue ever present is enough", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "only issue" }, USER)); // CK-1
      // (There is deliberately no deleteIssue — an issue can move to
      // Cancelled but never actually disappear from the file — so "the
      // project currently has an issue on disk" is exactly the condition
      // that should block a prefix change, with no way to launder around it
      // by trying to remove the issue first.)
      const renamed = applyProjectUpdate(getProject(p.id)!, { prefix: "RO" });
      expect(() => saveProject(renamed)).toThrow(/immutable|already has issues/i);
    });
  });
});

describe("applyProjectUpdate", () => {
  it("applies field changes and bumps updatedAt", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    const updated = applyProjectUpdate(p, { name: "Two", description: "d", repoPath: "/repo", archived: true });
    expect(updated).toMatchObject({ name: "Two", description: "d", repoPath: "/repo", archived: true });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(p.updatedAt);
  });

  it("normalises an updated prefix to uppercase", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    expect(applyProjectUpdate(p, { prefix: "ro" }).prefix).toBe("RO");
  });

  it("returns the same reference (no bumped updatedAt) when the patch matches every current field", () => {
    const p = buildProject({ name: "One", prefix: "CK", description: "d", repoPath: "/repo", archived: false });
    const updated = applyProjectUpdate(p, { name: "One", prefix: "ck", description: "d", repoPath: "/repo", archived: false });
    expect(updated).toBe(p);
  });

  it("is pure: does not mutate the input project", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    applyProjectUpdate(p, { name: "Two" });
    expect(p.name).toBe("One");
  });
});

describe("buildProject / applyProjectUpdate: value validation (regression)", () => {
  // "One construction path" (buildProject/applyProjectUpdate) only ever
  // controlled which fields a caller could set, never whether the values
  // were any good — that's the gap a REST route with no validation of its
  // own could walk straight through. These prove buildProject/
  // applyProjectUpdate themselves now reject bad values, so every caller
  // (REST, MCP, a future one) gets the same protection for free.

  it("buildProject rejects a non-string name", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: 12345, prefix: "CK" })).toThrow(/name must be a non-empty string/i);
  });

  it("buildProject rejects a non-string prefix", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: "One", prefix: 12345 })).toThrow(/prefix must be a non-empty string/i);
  });

  it("buildProject rejects a non-string description when provided", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: "One", prefix: "CK", description: 12345 })).toThrow(/description must be a string/i);
  });

  it("buildProject rejects a non-string repoPath when provided", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: "One", prefix: "CK", repoPath: 12345 })).toThrow(/repoPath must be a string/i);
  });

  it("buildProject rejects a non-boolean archived when provided", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: "One", prefix: "CK", archived: "yes" })).toThrow(/archived must be a boolean/i);
  });

  it("applyProjectUpdate rejects a non-string name when provided", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => applyProjectUpdate(p, { name: 12345 })).toThrow(/name must be a non-empty string/i);
  });

  it("applyProjectUpdate rejects a non-string prefix when provided", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => applyProjectUpdate(p, { prefix: 12345 })).toThrow(/prefix must be a non-empty string/i);
  });

  it("applyProjectUpdate rejects a non-string description when provided", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => applyProjectUpdate(p, { description: 12345 })).toThrow(/description must be a string/i);
  });

  it("applyProjectUpdate rejects a non-string repoPath when provided", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => applyProjectUpdate(p, { repoPath: 12345 })).toThrow(/repoPath must be a string/i);
  });

  it("applyProjectUpdate rejects a non-boolean archived when provided", () => {
    const p = buildProject({ name: "One", prefix: "CK" });
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => applyProjectUpdate(p, { archived: "yes" })).toThrow(/archived must be a boolean/i);
  });

  it("validates before persisting anything: a rejected buildProject call leaves projects.json untouched", () => {
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildProject({ name: "One", prefix: 12345 })).toThrow();
    expect(loadProjects()).toEqual([]);
  });
});

describe("deleteProject", () => {
  it("removes the project and returns true", () => {
    const p = makeProject("CK");
    expect(deleteProject(p.id)).toBe(true);
    expect(loadProjects()).toEqual([]);
  });

  it("returns false for an unknown id and leaves other projects alone", () => {
    makeProject("CK");
    expect(deleteProject("nope")).toBe(false);
    expect(loadProjects()).toHaveLength(1);
  });

  it("also removes the project's issues file", () => {
    const p = makeProject("CK");
    saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));
    expect(loadIssues(p.id)).toHaveLength(1);

    deleteProject(p.id);
    expect(loadIssues(p.id)).toEqual([]);
  });
});

describe("nextKey", () => {
  it("allocates sequential keys and persists the counter across calls", () => {
    const p = makeProject("CK");
    expect(nextKey(p.id)).toBe("CK-1");
    expect(nextKey(p.id)).toBe("CK-2");
    expect(nextKey(p.id)).toBe("CK-3");
    expect(getProject(p.id)?.nextNumber).toBe(4);
  });

  it("skips past a key that already exists on disk and persists the advance", () => {
    const p = makeProject("CK");
    // Hand-seed CK-1 directly, bypassing nextKey/buildIssue, to simulate the
    // counter having drifted behind what's actually on disk (e.g. a restored
    // backup or a hand-edited issues file).
    const seeded: Issue = {
      id: "seed-1",
      key: "CK-1",
      projectId: p.id,
      title: "seeded",
      description: "",
      status: "Backlog",
      createdAt: 1,
      updatedAt: 1,
      comments: [],
      attachments: [],
      activity: [],
    };
    saveIssue(seeded);

    expect(nextKey(p.id)).toBe("CK-2");
    expect(getProject(p.id)?.nextNumber).toBe(3);
    expect(nextKey(p.id)).toBe("CK-3");
  });

  it("throws for an unknown project", () => {
    expect(() => nextKey("nope")).toThrow(/Unknown project/);
  });

  it("treats a project with nextNumber 0 (e.g. a hand-edited record) as starting from 1", () => {
    const p = makeProject("CK");
    saveProject({ ...p, nextNumber: 0 });
    expect(nextKey(p.id)).toBe("CK-1");
  });

  it("does not create an issue as a side effect", () => {
    const p = makeProject("CK");
    nextKey(p.id);
    expect(loadIssues(p.id)).toEqual([]);
  });
});

describe("buildIssue", () => {
  it("defaults status to Backlog, empty comments/attachments, and one created activity entry", () => {
    const p = makeProject("CK");
    const actor: IssueActor = { kind: "session", sessionId: "s1", sessionName: "My session" };
    const issue = buildIssue({ projectId: p.id, title: "Do a thing", description: "details" }, actor);

    expect(issue.key).toBe("CK-1");
    expect(issue.status).toBe("Backlog");
    expect(issue.comments).toEqual([]);
    expect(issue.attachments).toEqual([]);
    expect(issue.activity).toHaveLength(1);
    expect(issue.activity[0]).toMatchObject({ kind: "created", actor });
  });

  it("defaults description to an empty string when omitted", () => {
    const p = makeProject("CK");
    expect(buildIssue({ projectId: p.id, title: "t" }, USER).description).toBe("");
  });

  it("throws for an unknown project and does not allocate a key", () => {
    expect(() => buildIssue({ projectId: "nope", title: "t" }, USER)).toThrow(/Unknown project/);
  });
});

describe("buildIssue: value validation (regression)", () => {
  // Same root problem as the project-side block above: "one construction
  // path" stopped a caller from choosing *which* fields to set (the
  // create_job bug), but did nothing about the *values* — a REST-shaped
  // payload like `{ title: 12345, priority: "critical", labels:
  // "not-an-array" }` used to be stored verbatim, while the MCP tool's own,
  // separate validation rejected the identical payload. buildIssue now
  // rejects it directly, so every caller gets the same protection.

  it("rejects a non-string title", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: 12345 }, USER)).toThrow(/title must be a non-empty string/i);
  });

  it("rejects an empty-string title", () => {
    const p = makeProject("CK");
    expect(() => buildIssue({ projectId: p.id, title: "" }, USER)).toThrow(/title must be a non-empty string/i);
  });

  it("rejects a whitespace-only title", () => {
    const p = makeProject("CK");
    expect(() => buildIssue({ projectId: p.id, title: "   " }, USER)).toThrow(/title must be a non-empty string/i);
  });

  it("rejects a non-string description when provided", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: "t", description: 12345 }, USER)).toThrow(/description must be a string/i);
  });

  it("rejects a non-numeric priority", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: "t", priority: "critical" }, USER)).toThrow(/priority must be one of/i);
  });

  it("rejects an out-of-range numeric priority", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: "t", priority: 99 }, USER)).toThrow(/priority must be one of/i);
  });

  it("accepts priority at both boundaries (0 and 4)", () => {
    const p = makeProject("CK");
    expect(buildIssue({ projectId: p.id, title: "t", priority: 0 }, USER).priority).toBe(0);
    expect(buildIssue({ projectId: p.id, title: "t", priority: 4 }, USER).priority).toBe(4);
  });

  it("rejects non-array labels", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: "t", labels: "not-an-array" }, USER)).toThrow(/labels must be an array of strings/i);
  });

  it("rejects a labels array containing a non-string element", () => {
    const p = makeProject("CK");
    // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
    expect(() => buildIssue({ projectId: p.id, title: "t", labels: ["ok", 5] }, USER)).toThrow(/labels must be an array of strings/i);
  });

  it("validates title before allocating a key: a rejected create does not advance nextNumber", () => {
    const p = makeProject("CK");
    expect(() => buildIssue({ projectId: p.id, title: "" }, USER)).toThrow();
    expect(getProject(p.id)?.nextNumber).toBe(1);
    expect(nextKey(p.id)).toBe("CK-1"); // still the first key, nothing was burned
  });
});

describe("saveIssue", () => {
  it("inserts a new issue and updates an existing one in place by id", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);
    saveIssue({ ...issue, title: "renamed" });

    const stored = loadIssues(p.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("renamed");
  });

  it("rejects a new issue whose key already belongs to a different issue", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);

    const impostor: Issue = { ...issue, id: "a-different-id" };
    expect(() => saveIssue(impostor)).toThrow(/already belongs to a different issue/);
  });

  it("leaves no .tmp-* file behind in ~/.cockpit after saving a project and an issue", () => {
    const p = makeProject("CK");
    saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));

    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
    expect(readdirSync(path.join(dir, "issues")).some((f) => f.includes(".tmp-"))).toBe(false);
  });
});

describe("saveIssue: status-change events (phase 4 onIssueStatus job trigger)", () => {
  // Real issue-events emitter, not mocked: this is the actual wiring
  // job-scheduler.ts subscribes to, so proving saveIssue emits through the
  // real module is what makes the phase-4 trigger trustworthy rather than
  // assumed. Every test unsubscribes so listeners never leak onto the next.
  let events: IssueStatusChangeEvent[];
  let unsub: () => void;

  beforeEach(() => {
    events = [];
    unsub = onIssueStatusChange((e) => events.push(e));
  });

  afterEach(() => unsub());

  it("emits with to only (no from) when an issue is first created", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);

    expect(events).toEqual([{ key: issue.key, projectId: p.id, from: undefined, to: "Backlog" }]);
  });

  it("emits with from/to on a real status transition", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);
    events.length = 0; // clear the creation emit above; this test is about the transition

    const updated = applyIssueUpdate(issue, { status: "Refine Ready" }, USER);
    saveIssue(updated);

    expect(events).toEqual([{ key: issue.key, projectId: p.id, from: "Backlog", to: "Refine Ready" }]);
  });

  it("does not emit when a save changes no status (e.g. a title-only edit)", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);
    events.length = 0;

    const updated = applyIssueUpdate(issue, { title: "New title" }, USER);
    saveIssue(updated);

    expect(events).toEqual([]);
  });

  it("does not emit when saveIssue itself rejects the write (unknown project)", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);

    expect(() => saveIssue({ ...issue, projectId: "nope" })).toThrow(/Unknown project/);
    expect(events).toEqual([]);
  });

  it("does not emit when saveIssue rejects a key collision", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    saveIssue(issue);
    events.length = 0;

    const impostor: Issue = { ...issue, id: "a-different-id", status: "Refine Ready" };
    expect(() => saveIssue(impostor)).toThrow(/already belongs to a different issue/);
    expect(events).toEqual([]);
  });
});

describe("getIssue", () => {
  it("finds an issue across multiple projects purely from its key's prefix", () => {
    const p1 = makeProject("ck");
    const p2 = makeProject("ro");
    const i1 = buildIssue({ projectId: p1.id, title: "one" }, USER);
    saveIssue(i1);
    const i2 = buildIssue({ projectId: p2.id, title: "two" }, USER);
    saveIssue(i2);

    expect(getIssue(i1.key)?.title).toBe("one");
    expect(getIssue(i2.key)?.title).toBe("two");
  });

  it("returns undefined for a key with no recognisable prefix", () => {
    expect(getIssue("nodash")).toBeUndefined();
  });

  it("returns undefined when the prefix matches no project", () => {
    makeProject("CK");
    expect(getIssue("ZZ-1")).toBeUndefined();
  });

  it("returns undefined for a known prefix but unknown issue number", () => {
    const p = makeProject("CK");
    saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));
    expect(getIssue("CK-999")).toBeUndefined();
  });

  describe("case-insensitivity (regression)", () => {
    it("resolves a fully lowercase key: the prefix lookup already normalised case, the final key comparison must too", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER)); // CK-1
      expect(getIssue("ck-1")?.title).toBe("t");
    });

    it("resolves mixed-case keys", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));
      expect(getIssue("Ck-1")?.title).toBe("t");
      expect(getIssue("cK-1")?.title).toBe("t");
    });

    it("still returns undefined for an unknown number regardless of case", () => {
      const p = makeProject("CK");
      saveIssue(buildIssue({ projectId: p.id, title: "t" }, USER));
      expect(getIssue("ck-999")).toBeUndefined();
    });
  });
});

describe("projectId path safety (regression)", () => {
  function rawIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      id: "raw-id",
      key: "ZZ-1",
      projectId: "unset",
      title: "t",
      description: "",
      status: "Backlog",
      createdAt: 1,
      updatedAt: 1,
      comments: [],
      attachments: [],
      activity: [],
      ...overrides,
    };
  }

  // Mirrors the coordinator's exact repro: with COCKPIT_CONFIG_DIR pointing
  // at a fresh tmpdir, projectId "../../escaped" resolves two levels above
  // issuesDir() (<dir>/issues) — i.e. one level above `dir` itself, the OS
  // tmpdir root in this test.
  function escapeTargetPath(): string {
    return path.join(path.dirname(dir), "escaped.json");
  }

  afterEach(() => {
    // Best-effort: fixed code should never create this file, but clean up
    // defensively so a regression can't leave litter outside the sandbox.
    rmSync(escapeTargetPath(), { force: true });
  });

  it("saveIssue rejects a projectId crafted to escape the cockpit dir, and creates nothing outside it", () => {
    const escaped = rawIssue({ projectId: "../../escaped" });
    expect(() => saveIssue(escaped)).toThrow(/Unknown project/);
    expect(existsSync(escapeTargetPath())).toBe(false);
  });

  it("loadIssues returns [] (not throw) for a projectId crafted to escape the cockpit dir", () => {
    expect(loadIssues("../../escaped")).toEqual([]);
    expect(existsSync(escapeTargetPath())).toBe(false);
  });

  it("saveIssue throws Unknown project for a plain unrelated unknown id too, not just a path-traversal one", () => {
    expect(() => saveIssue(rawIssue({ projectId: "totally-unknown-id" }))).toThrow(/Unknown project/);
  });

  it("loadIssues returns [] for a well-formed but unknown project id", () => {
    expect(loadIssues("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });

  it("rejects a path-escaping projectId even when a project record exists under that literal id (defense in depth)", () => {
    // saveProject only validates the prefix, not the shape of `id` — so a
    // project record with a malicious literal id is a reachable state, not
    // just a hypothetical. The path-containment check must catch this even
    // though the "is this a known project" check alone would happily pass.
    const malicious: Project = {
      id: "../../escaped",
      name: "Malicious",
      prefix: "ZZ",
      createdAt: 1,
      updatedAt: 1,
      nextNumber: 1,
    };
    saveProject(malicious);

    expect(() => saveIssue(rawIssue({ projectId: "../../escaped" }))).toThrow(/Unknown project/);
    expect(existsSync(escapeTargetPath())).toBe(false);
  });
});

describe("corrupt/missing file recovery", () => {
  it("loadProjects returns [] for a corrupt projects.json instead of throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "projects.json"), "{not valid json");
    expect(() => loadProjects()).not.toThrow();
    expect(loadProjects()).toEqual([]);
  });

  it("loadIssues returns [] for a corrupt issues file instead of throwing", () => {
    const p = makeProject("CK");
    mkdirSync(path.join(dir, "issues"), { recursive: true });
    writeFileSync(path.join(dir, "issues", `${p.id}.json`), "{not valid json");
    expect(() => loadIssues(p.id)).not.toThrow();
    expect(loadIssues(p.id)).toEqual([]);
  });

  it("loadIssues returns [] when no issues file exists yet for a real project", () => {
    const p = makeProject("CK");
    expect(loadIssues(p.id)).toEqual([]);
  });

  it("loadProjects returns [] for valid JSON that has no projects key", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "projects.json"), "{}");
    expect(loadProjects()).toEqual([]);
  });

  it("loadIssues returns [] for valid JSON that has no issues key", () => {
    const p = makeProject("CK");
    mkdirSync(path.join(dir, "issues"), { recursive: true });
    writeFileSync(path.join(dir, "issues", `${p.id}.json`), "{}");
    expect(loadIssues(p.id)).toEqual([]);
  });
});

describe("applyIssueUpdate", () => {
  function freshIssue(): Issue {
    const p = makeProject("CK");
    return buildIssue({ projectId: p.id, title: "Original", description: "orig desc", priority: 1, labels: ["a"] }, USER);
  }

  it("appends one field_changed activity entry per changed field", () => {
    const issue = freshIssue();
    const updated = applyIssueUpdate(issue, { title: "New title", status: "Refine Ready" }, { kind: "assistant" });

    expect(updated.title).toBe("New title");
    expect(updated.status).toBe("Refine Ready");
    const added = updated.activity.slice(issue.activity.length);
    expect(added).toHaveLength(2);
    expect(added.find((a) => a.field === "title")).toMatchObject({ kind: "field_changed", from: "Original", to: "New title" });
    expect(added.find((a) => a.field === "status")).toMatchObject({ kind: "field_changed", from: "Backlog", to: "Refine Ready" });
  });

  it("records description, priority and labels independently", () => {
    const issue = freshIssue();
    const updated = applyIssueUpdate(
      issue,
      { description: "new desc", priority: 3, labels: ["a", "b"] },
      { kind: "job", jobId: "j1", jobName: "Job", runId: "r1" },
    );
    const fields = updated.activity.slice(issue.activity.length).map((a) => a.field);
    expect(fields.sort()).toEqual(["description", "labels", "priority"]);
  });

  it("does not append activity, and returns the same object, when the patch matches every current field", () => {
    const issue = freshIssue();
    const updated = applyIssueUpdate(
      issue,
      { title: "Original", description: "orig desc", status: "Backlog", priority: 1, labels: ["a"] },
      USER,
    );
    expect(updated).toBe(issue);
    expect(updated.activity).toHaveLength(issue.activity.length);
  });

  it("treats an equal-by-value labels array (new reference, same contents) as unchanged", () => {
    const issue = freshIssue();
    const updated = applyIssueUpdate(issue, { labels: [...issue.labels!] }, USER);
    expect(updated).toBe(issue);
  });

  it("treats an explicit labels: undefined as unchanged when the issue already has no labels", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER); // no labels at all
    // Key present (unlike omitting it) so sameLabels actually runs: both sides
    // are undefined, which must short-circuit to "unchanged" rather than
    // falling through to the `.length` comparison below.
    const updated = applyIssueUpdate(issue, { labels: undefined }, USER);
    expect(updated).toBe(issue);
  });

  it("treats same-length labels with different contents as a real change (not just a length check)", () => {
    const issue = freshIssue(); // labels: ["a"]
    const updated = applyIssueUpdate(issue, { labels: ["b"] }, USER);
    expect(updated.labels).toEqual(["b"]);
    expect(updated.activity.at(-1)).toMatchObject({ field: "labels", from: ["a"], to: ["b"] });
  });

  it("clearing labels that were previously set is a real change", () => {
    const issue = freshIssue(); // labels: ["a"]
    const updated = applyIssueUpdate(issue, { labels: undefined }, USER);
    expect(updated.labels).toBeUndefined();
    expect(updated.activity.at(-1)).toMatchObject({ field: "labels", from: ["a"] });
  });

  it("distinguishes an explicit clear (undefined) of an optional field from omitting it", () => {
    const issue = freshIssue();

    const untouched = applyIssueUpdate(issue, {}, USER);
    expect(untouched).toBe(issue);

    const cleared = applyIssueUpdate(issue, { priority: undefined }, USER);
    expect(cleared.priority).toBeUndefined();
    const entry = cleared.activity[cleared.activity.length - 1];
    expect(entry).toMatchObject({ field: "priority", from: 1 });
    expect(entry.to).toBeUndefined();
  });

  it("bumps updatedAt only when something actually changed", () => {
    const issue = freshIssue();
    const before = issue.updatedAt;
    expect(applyIssueUpdate(issue, {}, USER).updatedAt).toBe(before);
    expect(applyIssueUpdate(issue, { title: "Changed" }, USER).updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("is pure: does not mutate the input issue", () => {
    const issue = freshIssue();
    applyIssueUpdate(issue, { title: "Changed" }, USER);
    expect(issue.title).toBe("Original");
    expect(issue.activity).toHaveLength(1);
  });

  describe("value validation (regression)", () => {
    // The coordinator's exact probe: calling applyIssueUpdate with the same
    // REST-shaped payload the PUT route passes through unvalidated used to
    // store `status: "Definitely Not A Status"`, `priority: "critical"`,
    // `labels: "not-an-array"` and `title: 12345` verbatim, while the
    // identical payload via the MCP update_issue tool was rejected. Every
    // case below is one field from that exact payload.

    it("rejects an invalid status", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { status: "Definitely Not A Status" }, USER)).toThrow(/status must be one of/i);
    });

    it("rejects a non-numeric priority", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { priority: "critical" }, USER)).toThrow(/priority must be one of/i);
    });

    it("rejects an out-of-range numeric priority", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { priority: 99 }, USER)).toThrow(/priority must be one of/i);
    });

    it("rejects non-array labels", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { labels: "not-an-array" }, USER)).toThrow(/labels must be an array of strings/i);
    });

    it("rejects a labels array containing a non-string element", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { labels: ["ok", 5] }, USER)).toThrow(/labels must be an array of strings/i);
    });

    it("rejects a non-string (or empty) title", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { title: 12345 }, USER)).toThrow(/title must be a non-empty string/i);
      expect(() => applyIssueUpdate(issue, { title: "" }, USER)).toThrow(/title must be a non-empty string/i);
    });

    it("rejects a non-string description", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { description: 12345 }, USER)).toThrow(/description must be a string/i);
    });

    it("still allows explicitly clearing priority/labels (undefined), which is not the same as an invalid value", () => {
      const issue = freshIssue(); // priority: 1, labels: ["a"]
      const cleared = applyIssueUpdate(issue, { priority: undefined, labels: undefined }, USER);
      expect(cleared.priority).toBeUndefined();
      expect(cleared.labels).toBeUndefined();
    });

    it("validates the whole patch before mutating anything: one bad field rejects the entire update, including its otherwise-valid fields", () => {
      const issue = freshIssue();
      // @ts-expect-error deliberately wrong-typed, mirroring an unvalidated REST body
      expect(() => applyIssueUpdate(issue, { title: "New valid title", status: "nonsense" }, USER)).toThrow();
      // Confirm no partial application: title must still be untouched.
      expect(issue.title).toBe("Original");
    });
  });
});

describe("addIssueComment / addIssueAttachment", () => {
  it("appends a comment and a commented activity entry without mutating the original issue", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    const actor: IssueActor = { kind: "assistant" };

    const updated = addIssueComment(issue, "hello world", actor);

    expect(issue.comments).toHaveLength(0);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]).toMatchObject({ body: "hello world", author: actor });
    expect(updated.activity.at(-1)).toMatchObject({ kind: "commented", actor });
  });

  it("appends an attachment and an attachment_added activity entry", () => {
    const p = makeProject("CK");
    const issue = buildIssue({ projectId: p.id, title: "t" }, USER);
    const actor: IssueActor = { kind: "session", sessionId: "s1", sessionName: "Sess" };

    const updated = addIssueAttachment(issue, { title: "Screenshot", url: "/attachments/1.png" }, actor);

    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]).toMatchObject({ title: "Screenshot", url: "/attachments/1.png" });
    expect(updated.activity.at(-1)).toMatchObject({ kind: "attachment_added", actor });
  });
});

describe("IssueActor kinds round-trip through storage", () => {
  it("persists and reloads all four actor kinds (assistant/job/session/user) faithfully", () => {
    const p = makeProject("CK");
    const actors: IssueActor[] = [
      { kind: "assistant" },
      { kind: "job", jobId: "j1", jobName: "Job", runId: "r1" },
      { kind: "session", sessionId: "s1", sessionName: "Sess" },
      { kind: "user" },
    ];

    let issue = buildIssue({ projectId: p.id, title: "t" }, actors[0]);
    for (const actor of actors.slice(1)) {
      issue = addIssueComment(issue, `by ${actor.kind}`, actor);
    }
    saveIssue(issue);

    const reloaded = getIssue(issue.key);
    expect(reloaded?.comments.map((c) => c.author)).toEqual(actors.slice(1));
    expect(reloaded?.activity[0].actor).toEqual(actors[0]);
  });
});

describe("persistAttachmentFile", () => {
  it("passes a remote url through untouched", () => {
    expect(persistAttachmentFile("CK-1", "https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  it("copies a local file into the issue-attachments root, preserving the extension", () => {
    const src = path.join(dir, "shot.jpg");
    writeFileSync(src, "bytes");
    const stored = persistAttachmentFile("CK-1", src);
    expect(stored.startsWith(path.join(getIssueAttachmentsRoot(), "CK-1"))).toBe(true);
    expect(stored.endsWith(".jpg")).toBe(true);
    expect(readFileSync(stored, "utf-8")).toBe("bytes");
  });

  it("survives deletion of the source, which is the whole point", () => {
    const src = path.join(dir, "transient.png");
    writeFileSync(src, "bytes");
    const stored = persistAttachmentFile("CK-1", src);
    rmSync(src);
    expect(existsSync(stored)).toBe(true);
  });

  it("leaves a file already inside the root where it is, without re-copying", () => {
    const root = path.join(getIssueAttachmentsRoot(), "CK-2");
    mkdirSync(root, { recursive: true });
    const src = path.join(root, "already.jpg");
    writeFileSync(src, "bytes");
    expect(persistAttachmentFile("CK-2", src)).toBe(src);
  });

  it("throws for a local path that does not exist rather than storing a dead link", () => {
    expect(() => persistAttachmentFile("CK-1", path.join(dir, "nope.jpg"))).toThrow(/does not exist/);
  });

  it("throws for a relative path", () => {
    expect(() => persistAttachmentFile("CK-1", "relative/path.jpg")).toThrow(/absolute path or a remote url/);
  });

  it("uppercases the key so the directory matches the issue key's canonical form", () => {
    const src = path.join(dir, "case.jpg");
    writeFileSync(src, "bytes");
    expect(persistAttachmentFile("ck-9", src)).toContain(path.join(getIssueAttachmentsRoot(), "CK-9"));
  });
});

describe("deleteIssue", () => {
  it("removes only the named issue from its project's file", () => {
    const project = buildProject({ name: "Delete", prefix: "DL" });
    saveProject(project);
    const a = buildIssue({ projectId: project.id, title: "a" }, { kind: "user" });
    const b = buildIssue({ projectId: project.id, title: "b" }, { kind: "user" });
    saveIssue(a);
    saveIssue(b);

    expect(deleteIssue(a.key)).toBe(true);
    expect(loadIssues(project.id).map((i) => i.key)).toEqual([b.key]);
  });

  it("returns false for a key that matches nothing, so a caller can 404", () => {
    const project = buildProject({ name: "Empty", prefix: "EM" });
    saveProject(project);

    expect(deleteIssue("EM-404"), "real project, no such issue").toBe(false);
    expect(deleteIssue("GONE-1"), "no such project").toBe(false);
    expect(deleteIssue("nonsense"), "not a key at all").toBe(false);
    expect(deleteIssue(""), "empty key").toBe(false);
  });

  it("takes the issue's attachment files with it", () => {
    const project = buildProject({ name: "Files", prefix: "FL" });
    saveProject(project);
    const issue = buildIssue({ projectId: project.id, title: "with a screenshot" }, { kind: "user" });
    saveIssue(issue);

    const source = path.join(dir, "shot.png");
    writeFileSync(source, "not really a png");
    const stored = persistAttachmentFile(issue.key, source);
    expect(existsSync(stored), "the file is copied into cockpit's own store").toBe(true);

    expect(deleteIssue(issue.key)).toBe(true);
    expect(existsSync(stored), "an issue's attachments must not outlive it").toBe(false);
  });

  it("leaves another issue's attachments alone", () => {
    const project = buildProject({ name: "Files2", prefix: "FT" });
    saveProject(project);
    const doomed = buildIssue({ projectId: project.id, title: "goes" }, { kind: "user" });
    const keeper = buildIssue({ projectId: project.id, title: "stays" }, { kind: "user" });
    saveIssue(doomed);
    saveIssue(keeper);

    const source = path.join(dir, "keep.png");
    writeFileSync(source, "keep me");
    const keeperFile = persistAttachmentFile(keeper.key, source);

    expect(deleteIssue(doomed.key)).toBe(true);
    expect(existsSync(keeperFile)).toBe(true);
  });
});
