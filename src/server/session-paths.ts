import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionPathListing } from "@/lib/session-tree";

/** Folders a tree never descends into: they are either generated or huge, and
 *  the Open File picker is still there for anything unusual. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".gradle",
  // Tool state, not source: screenshots and logs from the Playwright MCP, and
  // nested worktrees, which repeat a repository inside itself.
  ".playwright-mcp",
  ".worktrees",
]);

const GIT_EXCLUDES = [...SKIPPED_DIRECTORIES].filter((directory) => directory !== ".git").map((directory) => `--exclude=${directory}/`);

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function uniqueSorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

/** Shallow paths first, so a cap keeps the repository's own files rather than
 *  twenty thousand entries under one tool directory. */
function byDepthThenPath(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

interface GitListing {
  paths: string[];
  ignored: string[];
}

async function gitListing(root: string): Promise<GitListing> {
  const prefix = (await runGit(["rev-parse", "--show-prefix"], root)).trim();
  // Ignored files are listed too, but the generated directories above are
  // pruned so node_modules or target cannot fill the cap. --exclude only
  // affects the untracked side, which is where ignored files live.
  const [filesOut, ignoredOut] = await Promise.all([
    runGit(["ls-files", "-z", "--cached", "--others", "--full-name", ...GIT_EXCLUDES], root),
    // --directory keeps an ignored directory to one entry instead of every
    // file inside it; files ignored individually are listed as themselves.
    runGit(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--full-name"], root).catch(() => ""),
  ]);

  const relative = (entry: string): string | null => {
    if (prefix && !entry.startsWith(prefix)) return null;
    return prefix ? entry.slice(prefix.length) : entry;
  };

  const paths = uniqueSorted(
    filesOut
      .split("\0")
      .map(relative)
      .filter((entry): entry is string => !!entry),
  );

  const ignoredFiles = new Set<string>();
  const ignoredDirectories: string[] = [];
  for (const entry of ignoredOut.split("\0")) {
    const relativePath = relative(entry);
    if (!relativePath) continue;
    if (!relativePath.endsWith("/")) {
      ignoredFiles.add(relativePath);
      continue;
    }
    const directory = relativePath.slice(0, -1);
    if (!directory.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
      ignoredDirectories.push(relativePath);
    }
  }

  const ignored = paths.filter((entry) => ignoredFiles.has(entry) || ignoredDirectories.some((directory) => entry.startsWith(directory)));

  return { paths, ignored };
}

async function walkPaths(root: string): Promise<string[]> {
  const paths: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted so a capped listing is the same on every request.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        paths.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }

  await walk(root);
  return uniqueSorted(paths);
}

/** An expanded folder's immediate children are normally a handful; this only
 *  bounds a pathological directory whose readdir itself is huge. */
export const MAX_DIRECTORY_ENTRIES = 5_000;

/** Ask git which of these entries its ignore rules cover. Exit 1 means none;
 *  any other failure (not a repository, no git) means nothing is marked. */
function ignoredEntries(root: string, entries: readonly string[]): Promise<Set<string>> {
  if (entries.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", root, "check-ignore", "--stdin", "-z"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as { code?: number }).code !== 1) {
        resolve(new Set());
        return;
      }
      resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
    child.stdin?.end(entries.map((entry) => entry.replace(/\/$/, "")).join("\0") + "\0");
  });
}

/**
 * One directory's immediate children, for the lazy Files tree: the top level
 * is listed first, and a folder is listed when it is expanded. Directories
 * carry a trailing slash so the tree can draw them before their children are
 * known. Generated folders are not descended into, and git-ignored entries
 * are marked so the tree can mute them.
 */
export async function listSessionDirectory(cwd: string, dir = ""): Promise<SessionPathListing> {
  const root = path.resolve(cwd);
  const target = path.resolve(root, dir);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Not this session's folder");

  let entries: Dirent[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    throw new Error("Cannot list this folder");
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const relative = path.relative(root, path.join(target, entry.name)).split(path.sep).join("/");
    if (entry.isDirectory()) paths.push(`${relative}/`);
    else if (entry.isFile()) paths.push(relative);
  }

  const shown = paths.slice(0, MAX_DIRECTORY_ENTRIES);
  const ignored = await ignoredEntries(root, shown);
  return {
    paths: shown,
    ignored: shown.filter((entry) => ignored.has(entry) || ignored.has(entry.replace(/\/$/, ""))),
    truncated: paths.length > shown.length,
  };
}

/**
 * Every file under a session's directory, as tree-ready relative paths.
 *
 * Git repositories use the index plus untracked files, including git-ignored
 * files (marked so the tree can mute them) but not generated directories such
 * as node_modules; anything else gets a bounded recursive walk. Kept for the
 * Open File picker, which needs the whole tree at once; the sidebar lists one
 * expanded folder at a time (listSessionDirectory).
 */
export async function listSessionPaths(cwd: string, maxEntries = 20_000): Promise<SessionPathListing> {
  const root = path.resolve(cwd);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Not a directory");

  let listing: GitListing;
  try {
    listing = await gitListing(root);
  } catch {
    listing = { paths: await walkPaths(root), ignored: [] };
  }

  const paths = [...listing.paths].sort(byDepthThenPath).slice(0, maxEntries);
  const visible = new Set(paths);
  return {
    paths,
    ignored: listing.ignored.filter((entry) => visible.has(entry)),
    truncated: listing.paths.length > maxEntries,
  };
}
