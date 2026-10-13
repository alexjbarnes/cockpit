import { execFile } from "node:child_process";
import type { NextRequest } from "next/server";
import { validateSession } from "@/server/auth";
import { TtlCache } from "@/server/ttl-cache";

/**
 * The shared half of the /api/github routes: authenticate, run `gh`, and hold
 * the successful reads in memory.
 *
 * The reads are the right shape for a cache — the same handful of questions
 * (this repo's open PRs, this PR's files, this file at this commit) asked over
 * and over, with answers that change on the scale of minutes. Every navigation
 * used to spawn a fresh `gh` for each of them.
 */
export const GH_TTL = {
  /** Lists and check runs: things that move while the user is looking. */
  fast: 60_000,
  /** One PR's own record: title, body, files, review decision. */
  medium: 5 * 60_000,
  /** A repo's directory data, and a file's contents at a known commit. */
  slow: 60 * 60_000,
} as const;

/** Past this, a read is not worth holding in memory — a whole PR's diff can be
 *  tens of megabytes. Not storing it costs one re-run, which is the honest
 *  price of not pinning it. */
const MAX_CACHED_CHARS = 1024 * 1024;

const cache = new TtlCache<string>();

export function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export interface RunOptions {
  /** Bytes of stdout to accept. A diff needs much more than the 10 MB default. */
  maxBuffer?: number;
  /** Resolve with stdout even when gh exits badly: `gh pr diff` writes a
   *  truncated diff and reports an error alongside it. */
  allowStdoutOnError?: boolean;
}

/** Run `gh` and resolve its stdout. */
export function run(args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve(stdout);
      const code = (err as NodeJS.ErrnoException).code;
      if (options.allowStdoutOnError && !code && stdout) return resolve(stdout);
      reject(err);
    });
  });
}

export interface CachedRunOptions extends RunOptions {
  /** Run as if nothing were cached, and replace what is. The Refresh buttons
   *  ask for this the way a browser hard reload does. */
  bypass?: boolean;
}

/**
 * `run`, served from memory when the same read is made again within `ttlMs`.
 *
 * Only a successful run is stored: a failure is a statement about right now
 * (gh is not signed in, the network is down) and caching it would make the
 * retry the user is about to make pointless.
 */
export async function runCached(key: string, ttlMs: number, args: string[], options: CachedRunOptions = {}): Promise<string> {
  if (!options.bypass) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const stdout = await run(args, options);
  if (stdout.length <= MAX_CACHED_CHARS) cache.set(key, stdout, ttlMs);
  return stdout;
}

/** Forget the reads a write has just made wrong, by exact key. */
export function invalidateGhReads(...keys: string[]): void {
  for (const key of keys) cache.delete(key);
}

/** Forget a whole family, for reads whose keys vary (a repo's PR lists). */
export function invalidateGhReadsByPrefix(...prefixes: string[]): void {
  for (const prefix of prefixes) cache.deleteByPrefix(prefix);
}

/**
 * Whether the caller asked for a reading taken now rather than one from
 * memory. A GET carries no body, so a request header is the only way to say
 * so; the Refresh buttons send `cache-control: no-cache`.
 */
export function wantsFreshData(req: NextRequest): boolean {
  const value = req.headers.get("cache-control") ?? "";
  return value.includes("no-cache") || value.includes("no-store") || value.includes("max-age=0");
}
