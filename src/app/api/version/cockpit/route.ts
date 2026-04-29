import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

const NPM_LATEST_URL = "https://registry.npmjs.org/@alexjbarnes/cockpit/latest";

type NpmLatest = { version?: string };

export async function GET() {
  let installed = "unknown";
  let latest = "unknown";

  try {
    const text = await readFile(resolve(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(text) as { version?: string };
    if (typeof pkg.version === "string") installed = pkg.version;
  } catch {
    // package.json unreadable
  }

  try {
    const res = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = (await res.json()) as NpmLatest;
      if (typeof data.version === "string") latest = data.version;
    }
  } catch {
    // registry unreachable or package not yet published
  }

  return NextResponse.json({ installed, latest });
}
