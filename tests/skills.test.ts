// Skills on disk: what counts as one, in a `.claude/skills` directory read
// for the skills pages and in a project's repo read for its workflow.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasRepoSkill, listRepoSkills, parseFrontmatter, readSkillsFromDir, repoSkillPath, SKILL_NAME } from "@/server/skills";

let repo: string;

function skill(name: string, content: string | null): void {
  const where = path.join(repo, ".claude", "skills", name);
  mkdirSync(where, { recursive: true });
  if (content !== null) writeFileSync(path.join(where, "SKILL.md"), content);
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "cockpit-skills-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
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
