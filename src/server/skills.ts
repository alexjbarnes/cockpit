// Skills on disk: the folders under a `.claude/skills` directory that hold a
// SKILL.md. Shared by the skills pages (user and project skills) and by
// workflows, whose agents run a skill from the project's own repo.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getClaudeDir } from "./paths";

export interface SkillInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
}

/** A skill in a repo, named by its folder: that is what a workflow stores and
 *  what is joined into a path, whatever the file calls itself. */
export interface RepoSkill {
  name: string;
  description?: string;
  /** Relative to the repo, for telling a person where it is. */
  path: string;
}

/** A skill's folder name must be safe to join into a path. */
export const SKILL_NAME = /^[A-Za-z0-9_-]{1,100}$/;

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) fields[key] = val;
  }
  return fields;
}

export async function readSkillsFromDir(dir: string, scope: "user" | "project"): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    try {
      const s = await stat(skillDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      const content = await readFile(skillFile, "utf-8");
      const fm = parseFrontmatter(content);
      skills.push({
        name: fm.name || entry,
        scope,
        description: fm.description,
      });
    } catch {
      // Directory exists but no SKILL.md -- skip
    }
  }
  return skills;
}

/** Where a repo keeps a skill, relative to the repo. */
export function repoSkillPath(name: string): string {
  return path.posix.join(".claude", "skills", name, "SKILL.md");
}

/** Whether `dir` (a repo, or a worktree of one) holds the skill. */
export function hasRepoSkill(dir: string | undefined, name: string): boolean {
  if (!dir || !SKILL_NAME.test(name)) return false;
  return existsSync(path.join(dir, ".claude", "skills", name, "SKILL.md"));
}

/** The skills in a repo's own `.claude/skills`, by folder name. */
export function listRepoSkills(dir: string | undefined): RepoSkill[] {
  if (!dir) return [];
  const root = path.join(dir, ".claude", "skills");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: RepoSkill[] = [];
  for (const entry of entries.sort()) {
    if (!SKILL_NAME.test(entry)) continue;
    const file = path.join(root, entry, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
      const description = parseFrontmatter(readFileSync(file, "utf-8")).description;
      skills.push({ name: entry, ...(description ? { description } : {}), path: repoSkillPath(entry) });
    } catch {
      // No SKILL.md in it: not a skill.
    }
  }
  return skills;
}

/** A skill a workflow can run: from the user's own directory or a repo. */
export interface WorkflowSkill extends RepoSkill {
  scope: "user" | "repo";
}

/** Where the CLI keeps a user-level skill, whatever CLAUDE_CONFIG_DIR says. */
export function userSkillPath(name: string): string {
  return path.join(getClaudeDir(), "skills", name, "SKILL.md");
}

/** Whether the user has a skill of this name. */
export function hasUserSkill(name: string): boolean {
  if (!SKILL_NAME.test(name)) return false;
  return existsSync(userSkillPath(name));
}

/**
 * Whether a workflow can run this skill in `dir` (a repo or one of its
 * worktrees): the repo's own copy first, then the user's.
 */
export function hasWorkflowSkill(dir: string | undefined, name: string): boolean {
  return hasRepoSkill(dir, name) || hasUserSkill(name);
}

/** The path a workflow's prompt should name for the skill it is about to run. */
export function workflowSkillPath(dir: string | undefined, name: string): string {
  return hasRepoSkill(dir, name) ? repoSkillPath(name) : userSkillPath(name);
}

/** The user's own skills, by folder name, for the workflow editors. */
export function listUserSkills(): WorkflowSkill[] {
  const root = path.join(getClaudeDir(), "skills");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: WorkflowSkill[] = [];
  for (const entry of entries.sort()) {
    if (!SKILL_NAME.test(entry)) continue;
    const file = path.join(root, entry, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
      const description = parseFrontmatter(readFileSync(file, "utf-8")).description;
      skills.push({
        name: entry,
        ...(description ? { description } : {}),
        path: file,
        scope: "user",
      });
    } catch {
      // No SKILL.md in it: not a skill.
    }
  }
  return skills;
}

/**
 * Every skill a workflow could name, across the user directory and the given
 * repos. A repo's copy replaces a user skill of the same name, and the first
 * repo wins among duplicates, matching what a run in that repo would load.
 */
export function listWorkflowSkills(repoPaths: readonly (string | undefined)[]): WorkflowSkill[] {
  const byName = new Map<string, WorkflowSkill>();
  for (const skill of listUserSkills()) byName.set(skill.name, skill);
  for (const dir of repoPaths) {
    for (const skill of listRepoSkills(dir)) byName.set(skill.name, { ...skill, scope: "repo" });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
