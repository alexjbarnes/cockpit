import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const LIMIT = 50;
const MAX_DEPTH = 5;
const MAX_FILES = 5000;

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".venv", "vendor", ".cache", "build", "coverage"]);

async function listFiles(cwd: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        results.push(relative(cwd, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  }

  await walk(cwd, 0);
  return results;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const query = (url.searchParams.get("query") || "").toLowerCase();

  const lines = await listFiles(cwd);

  if (!query) {
    return NextResponse.json({ files: lines.slice(0, LIMIT) });
  }

  const matched: string[] = [];
  for (const line of lines) {
    if (line.toLowerCase().includes(query)) {
      matched.push(line);
      if (matched.length >= LIMIT) break;
    }
  }
  return NextResponse.json({ files: matched });
}
