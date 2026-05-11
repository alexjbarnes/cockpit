import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

interface ChangelogRelease {
  version: string;
  date: string;
  sections: Array<{ heading: string; items: string[] }>;
}

let cache: { releases: ChangelogRelease[]; repo: string; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

function parseChangelog(md: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let currentSection: { heading: string; items: string[] } | null = null;

  for (const line of md.split("\n")) {
    const versionMatch = line.match(/^## \[([^\]]+)\]\s*-\s*(\S+)/);
    if (versionMatch) {
      if (current) releases.push(current);
      current = { version: versionMatch[1], date: versionMatch[2], sections: [] };
      currentSection = null;
      continue;
    }

    if (!current) continue;

    const sectionMatch = line.match(/^### (.+)/);
    if (sectionMatch) {
      currentSection = { heading: sectionMatch[1], items: [] };
      current.sections.push(currentSection);
      continue;
    }

    if (currentSection && line.startsWith("- ")) {
      currentSection.items.push(line.slice(2));
    }
  }
  if (current) releases.push(current);
  return releases;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ releases: cache.releases, repo: cache.repo });
  }

  let repo = "alexjbarnes/cockpit";
  try {
    const text = await readFile(resolve(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(text) as { repository?: { url?: string } };
    const match = pkg.repository?.url?.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match) repo = match[1];
  } catch {
    // use default
  }

  const rawUrl = `https://raw.githubusercontent.com/${repo}/refs/heads/main/CHANGELOG.md`;
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return NextResponse.json({ releases: [], repo });
    const md = await res.text();
    const releases = parseChangelog(md);
    cache = { releases, repo, ts: Date.now() };
    return NextResponse.json({ releases, repo });
  } catch {
    return NextResponse.json({ releases: [], repo });
  }
}
