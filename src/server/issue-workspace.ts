// An issue's own checkout: a git worktree of its project's repository, on a
// branch named after the issue, that every agent on the issue works in.
//
// Several issues are worked at once, and two sessions cannot share one
// checkout: each would see the other's half-finished files and switch the
// other's branch. A worktree per issue gives each its own files while sharing
// the repository's history, and it outlives any one run, so the agent that
// validates finds what the agent that built left.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Issue, IssueWorkspace, Project } from "@/types";
import { getCockpitDir } from "./paths";

/** Long enough for a fetch over a slow link; a hung git must not hold a slot for ever. */
const GIT_TIMEOUT_MS = 120_000;

export function workspaceRoot(): string {
  return join(getCockpitDir(), "worktrees");
}

export function workspaceBranch(issueKey: string): string {
  return `issue/${issueKey.toUpperCase()}`;
}

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" ")));
      else resolve(stdout.trim());
    });
  });
}

/** Whether a git command succeeds, for the questions git answers by exit code. */
function gitOk(repo: string, args: string[]): Promise<boolean> {
  return git(repo, args).then(
    () => true,
    () => false,
  );
}

// One git command tree at a time per repository. Two `worktree add`s racing
// in one repository can each find the other's lock and fail.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(repo: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(repo) ?? Promise.resolve()).then(task, task);
  queues.set(
    repo,
    next.catch(() => {}),
  );
  return next;
}

/**
 * What an issue's branch starts from. The project's base branch as the remote
 * has it, when there is a remote and it could be fetched; else the local
 * branch of that name; and with no base branch named, whatever the remote
 * calls its default, or failing that the commit the repository is on.
 */
async function resolveBase(repo: string, baseBranch: string | undefined): Promise<string> {
  const hasRemote = await gitOk(repo, ["remote", "get-url", "origin"]);
  if (baseBranch) {
    if (hasRemote && !(await gitOk(repo, ["fetch", "origin", baseBranch]))) {
      throw new Error(`Could not fetch "${baseBranch}" from origin in ${repo}`);
    }
    if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`])) return `origin/${baseBranch}`;
    if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`])) return baseBranch;
    throw new Error(`The base branch "${baseBranch}" does not exist in ${repo}`);
  }
  if (hasRemote) {
    if (!(await gitOk(repo, ["fetch", "origin"]))) {
      throw new Error(`Could not fetch origin in ${repo}`);
    }
    const head = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
    if (head) return head;
    // A clone that never had its remote HEAD set: the branch the remote
    // actually has beats whatever this checkout happens to be on.
    for (const candidate of ["main", "master"]) {
      if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])) return `origin/${candidate}`;
    }
  }
  return "HEAD";
}

/** Git identity flags only for the halves a machine has not configured, so a
 *  merge can finish on a fresh server or CI runner without a global identity. */
async function identityArgs(dir: string): Promise<string[]> {
  const [name, email] = await Promise.all([
    git(dir, ["config", "user.name"]).catch(() => ""),
    git(dir, ["config", "user.email"]).catch(() => ""),
  ]);
  return [...(name.trim() ? [] : ["-c", "user.name=Cockpit"]), ...(email.trim() ? [] : ["-c", "user.email=cockpit@localhost"])];
}

/**
 * Bring a clean issue worktree up to date with the base before a new stage
 * works in it. The worktree is cut once and would otherwise stay on the base
 * as it was that day; a dirty one is someone's unfinished work and is left
 * alone. A merge that conflicts is aborted and reported rather than leaving
 * the worktree half-merged.
 */
async function refreshWorkspace(worktree: string, base: string): Promise<void> {
  const dirty = await git(worktree, ["status", "--porcelain"]).catch(() => "unreadable");
  if (dirty) return;
  const behind = await git(worktree, ["rev-list", "--count", `HEAD..${base}`]).catch(() => "0");
  if (Number(behind) === 0) return;
  const identity = await identityArgs(worktree);
  try {
    await git(worktree, [...identity, "merge", "--no-edit", base]);
  } catch (err) {
    // Graph files are generated documentation, and every branch that records
    // what it learned edits the same node files as the base. A conflict there
    // is not a code conflict, and holding the next stage on it wedges an
    // issue whose code merged perfectly well. Keep this branch's graph and
    // finish the merge; anything else is a real conflict and is aborted.
    const conflicted = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);
    if (conflicted.length > 0 && conflicted.every((file) => file.startsWith(".graphene/"))) {
      try {
        await git(worktree, ["checkout", "--ours", "--", ...conflicted]);
        await git(worktree, ["add", "--", ...conflicted]);
        await git(worktree, [...identity, "commit", "--no-edit"]);
        return;
      } catch {
        // Fall through to the abort: a half-finished merge is worse than a
        // reported failure.
      }
    }
    await gitOk(worktree, ["merge", "--abort"]);
    throw new Error(`Could not bring ${worktree} up to date with ${base}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The issue's worktree, made if it is not there. An issue that already has
 * one keeps it; a branch that already exists (the worktree was removed, the
 * work was not) is checked out again rather than started over.
 */
export function ensureWorkspace(project: Project, issue: Pick<Issue, "key" | "workspace">): Promise<IssueWorkspace> {
  const repo = project.repoPath;
  if (!repo || !existsSync(repo)) return Promise.reject(new Error(`Project "${project.name}" has no repository folder`));
  return inTurn(repo, async () => {
    if (!(await gitOk(repo, ["rev-parse", "--git-dir"]))) throw new Error(`${repo} is not a git repository`);
    const existing = issue.workspace;
    if (existing && existsSync(join(existing.path, ".git"))) {
      // The base moves on while the issue is open, and the worktree is cut
      // once. Bring a clean one up to date before the next stage reads it.
      await refreshWorkspace(existing.path, await resolveBase(repo, project.baseBranch));
      return existing;
    }

    const branch = workspaceBranch(issue.key);
    const path = join(workspaceRoot(), `${basename(repo)}-${issue.key.toUpperCase()}`);
    mkdirSync(workspaceRoot(), { recursive: true });
    // Forget worktrees whose folders are gone, or git refuses the path as taken.
    await gitOk(repo, ["worktree", "prune"]);
    if (existsSync(join(path, ".git"))) {
      await refreshWorkspace(path, await resolveBase(repo, project.baseBranch));
      return { path, branch, base: existing?.base ?? "", createdAt: existing?.createdAt ?? Date.now() };
    }

    if (await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
      await git(repo, ["worktree", "add", path, branch]);
      await refreshWorkspace(path, await resolveBase(repo, project.baseBranch));
      return { path, branch, base: existing?.base ?? "", createdAt: Date.now() };
    }
    const base = await resolveBase(repo, project.baseBranch);
    await git(repo, ["worktree", "add", path, "-b", branch, base]);
    return { path, branch, base, createdAt: Date.now() };
  });
}

/**
 * Take an issue's worktree away. The branch is left: it is the record of the
 * work, and a merged one is the repository's to delete. Never throws: a
 * worktree that will not go is a folder to clear by hand, not a reason to
 * fail what the issue was doing.
 */
export function removeWorkspace(project: Project | undefined, workspace: IssueWorkspace): Promise<void> {
  const repo = project?.repoPath;
  if (!repo || !existsSync(repo)) return Promise.resolve();
  return inTurn(repo, async () => {
    if (existsSync(workspace.path)) await gitOk(repo, ["worktree", "remove", "--force", workspace.path]);
    await gitOk(repo, ["worktree", "prune"]);
  });
}
