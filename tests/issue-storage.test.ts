// Unit tests for the file-based issue/project store. Exercises the CRUD,
// key-allocation and activity-logging functions against a real tmpdir via
// COCKPIT_CONFIG_DIR (getCockpitDir reads the env var per call, so no fs
// mocking is needed), mirroring tests/job-storage.test.ts's isolation
// convention.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addIssueAttachment,
  addIssueComment,
  applyIssueUpdate,
  applyProjectUpdate,
  buildIssue,
  buildProject,
  deleteProject,
  getIssue,
  getProject,
  loadIssues,
  loadProjects,
  nextKey,
  saveIssue,
  saveProject,
} from "@/server/issue-storage";
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

    it("rejects an empty/blank prefix", () => {
      const p = buildProject({ name: "Cockpit", prefix: "   " });
      expect(() => saveProject(p)).toThrow(/prefix must not be empty/i);
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
