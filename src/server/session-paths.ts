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

/**
 * Every file under a session's directory, as tree-ready relative paths.
 *
 * Git repositories use the index plus untracked files, including git-ignored
 * files (marked so the tree can mute them) but not generated directories such
 * as node_modules; anything else gets a bounded recursive walk.
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

  const paths = listing.paths.slice(0, maxEntries);
  const visible = new Set(paths);
  return {
    paths,
    ignored: listing.ignored.filter((entry) => visible.has(entry)),
    truncated: listing.paths.length > maxEntries,
  };
}
