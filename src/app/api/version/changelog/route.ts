import { NextResponse } from "next/server";

interface ChangelogRelease {
  version: string;
  items: string[];
}

let cache: { releases: ChangelogRelease[]; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

const RAW_URL = "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md";

function parseChangelog(md: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;

  for (const line of md.split("\n")) {
    const versionMatch = line.match(/^## (\S+)/);
    if (versionMatch) {
      if (current) releases.push(current);
      current = { version: versionMatch[1], items: [] };
      continue;
    }
    if (current && line.startsWith("- ")) {
      current.items.push(line.slice(2));
    }
  }
  if (current) releases.push(current);
  return releases;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ releases: cache.releases });
  }

  try {
    const res = await fetch(RAW_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return NextResponse.json({ releases: [] });
    const md = await res.text();
    const releases = parseChangelog(md);
    cache = { releases, ts: Date.now() };
    return NextResponse.json({ releases });
  } catch {
    return NextResponse.json({ releases: [] });
  }
}
