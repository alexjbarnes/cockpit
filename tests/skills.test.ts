// Skills on disk: what counts as one, in a `.claude/skills` directory read
// for the skills pages and in a project's repo read for its workflow.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasRepoSkill,
  hasUserSkill,
  hasWorkflowSkill,
  listRepoSkills,
  listUserSkills,
  listWorkflowSkills,
  parseFrontmatter,
  readSkillsFromDir,
  repoSkillPath,
  SKILL_NAME,
  userSkillPath,
  workflowSkillPath,
} from "@/server/skills";

let repo: string;
let claudeDir: string;
let prevClaudeDir: string | undefined;

function skill(name: string, content: string | null): void {
  const where = path.join(repo, ".claude", "skills", name);
  mkdirSync(where, { recursive: true });
  if (content !== null) writeFileSync(path.join(where, "SKILL.md"), content);
}

function userSkill(name: string, content: string | null): void {
  const where = path.join(claudeDir, "skills", name);
  mkdirSync(where, { recursive: true });
  if (content !== null) writeFileSync(path.join(where, "SKILL.md"), content);
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "cockpit-skills-"));
  claudeDir = mkdtempSync(path.join(tmpdir(), "cockpit-claude-"));
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});

afterEach(() => {
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  rmSync(repo, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

describe("a skill's frontmatter", () => {
  it("is read as simple key and value lines", () => {
    expect(parseFrontmatter("---\nname: plan-issue\ndescription: Plans: carefully.\nempty:\nnot a pair\n---\nBody")).toEqual({
      name: "plan-issue",
      description: "Plans: carefully.",
    });
    expect(parseFrontmatter("---\r\nname: x\r\n---\r\n")).toEqual({ name: "x" });
    expect(parseFrontmatter("No frontmatter here")).toEqual({});
  });
});

describe("the skills in a repo", () => {
  it("are the folders with a SKILL.md, named by folder, in order", () => {
    skill("plan-issue", "---\nname: Planner\ndescription: Writes the plan.\n---\nDo it.");
    skill("build", "No frontmatter.");
    skill("empty-folder", null);
    skill("has a space", "---\ndescription: Not a safe name.\n---");
    writeFileSync(path.join(repo, ".claude", "skills", "notes.md"), "a file, not a skill");
    // A folder called SKILL.md is not a skill either.
    mkdirSync(path.join(repo, ".claude", "skills", "odd", "SKILL.md"), { recursive: true });

    expect(listRepoSkills(repo)).toEqual([
      { name: "build", path: ".claude/skills/build/SKILL.md" },
      { name: "plan-issue", description: "Writes the plan.", path: ".claude/skills/plan-issue/SKILL.md" },
    ]);
    expect(hasRepoSkill(repo, "plan-issue")).toBe(true);
    expect(hasRepoSkill(repo, "empty-folder")).toBe(false);
    expect(hasRepoSkill(repo, "missing")).toBe(false);
  });

  it("are none when the repo has no skills folder, or there is no repo", () => {
    expect(listRepoSkills(repo)).toEqual([]);
    expect(listRepoSkills(undefined)).toEqual([]);
    expect(hasRepoSkill(undefined, "plan-issue")).toBe(false);
  });

  it("are never looked for outside the skills folder", () => {
    writeFileSync(path.join(repo, "SKILL.md"), "top level");
    expect(hasRepoSkill(repo, "../..")).toBe(false);
    expect(hasRepoSkill(repo, "")).toBe(false);
    expect(SKILL_NAME.test("plan-issue_2")).toBe(true);
    expect(SKILL_NAME.test("a/b")).toBe(false);
    expect(repoSkillPath("plan-issue")).toBe(".claude/skills/plan-issue/SKILL.md");
  });
});

describe("a skills directory read for the skills pages", () => {
  it("lists each skill by the name it gives itself, with its scope", async () => {
    skill("plan-issue", "---\nname: Planner\ndescription: Writes the plan.\n---");
    skill("build", "No frontmatter.");
    skill("empty-folder", null);
    writeFileSync(path.join(repo, ".claude", "skills", "notes.md"), "a file");
    const found = await readSkillsFromDir(path.join(repo, ".claude", "skills"), "project");
    expect(found.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "build", scope: "project", description: undefined },
      { name: "Planner", scope: "project", description: "Writes the plan." },
    ]);
    expect(await readSkillsFromDir(path.join(repo, "nope"), "user")).toEqual([]);
  });
});

describe("the skills a workflow can run", () => {
  it("falls back to the user's own skills, with the repo's copy winning", () => {
    skill("plan-issue", "---\ndescription: Repo plan.\n---");
    userSkill("plan-issue", "---\ndescription: User plan.\n---");
    userSkill("review", "---\ndescription: User review.\n---");

    expect(hasUserSkill("review")).toBe(true);
    expect(hasUserSkill("missing")).toBe(false);
    expect(hasUserSkill("a/b")).toBe(false);
    expect(userSkillPath("review")).toBe(path.join(claudeDir, "skills", "review", "SKILL.md"));

    expect(hasWorkflowSkill(repo, "plan-issue")).toBe(true);
    expect(hasWorkflowSkill(repo, "review")).toBe(true);
    expect(hasWorkflowSkill(undefined, "review")).toBe(true);
    expect(hasWorkflowSkill(undefined, "missing")).toBe(false);
    expect(workflowSkillPath(repo, "plan-issue")).toBe(".claude/skills/plan-issue/SKILL.md");
    expect(workflowSkillPath(repo, "review")).toBe(userSkillPath("review"));
  });

  it("lists user skills and every project's repo skills, with a repo replacing a user copy", () => {
    userSkill("plan-issue", "---\ndescription: User plan.\n---");
    userSkill("review", "---\ndescription: User review.\n---");
    skill("plan-issue", "---\ndescription: Repo plan.\n---");

    const second = mkdtempSync(path.join(tmpdir(), "cockpit-skills-two-"));
    try {
      mkdirSync(path.join(second, ".claude", "skills", "review"), { recursive: true });
      writeFileSync(path.join(second, ".claude", "skills", "review", "SKILL.md"), "---\ndescription: Second repo review.\n---");

      const skills = listWorkflowSkills([repo, second]);
      expect(skills.map((s) => s.name)).toEqual(["plan-issue", "review"]);
      expect(skills.find((s) => s.name === "plan-issue")).toMatchObject({
        scope: "repo",
        path: ".claude/skills/plan-issue/SKILL.md",
        description: "Repo plan.",
      });
      expect(skills.find((s) => s.name === "review")).toMatchObject({ scope: "repo", description: "Second repo review." });
      expect(listUserSkills().map((s) => s.name)).toEqual(["plan-issue", "review"]);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});
