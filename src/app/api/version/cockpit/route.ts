import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);
const NPM_LATEST_URL = "https://registry.npmjs.org/@alexjbarnes/cockpit/latest";

type NpmLatest = { version?: string };
type InstallMethod = "npm" | "npx" | "dev";

function detectInstallMethod(): InstallMethod {
  if (process.env.NODE_ENV !== "production") return "dev";
  const script = process.argv[1] || "";
  if (script.includes("/_npx/") || script.includes("\\_npx\\")) return "npx";
  return "npm";
}

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

  const installMethod = detectInstallMethod();
  const updateCommand = installMethod === "npm" ? "npm install -g @alexjbarnes/cockpit" : null;

  return NextResponse.json({ installed, latest, installMethod, updateCommand });
}

export async function POST() {
  const method = detectInstallMethod();

  if (method === "dev") {
    return NextResponse.json({ error: "Running in dev mode, update from source" }, { status: 400 });
  }
  if (method === "npx") {
    return NextResponse.json({ error: "Running via npx, restart to get the latest version" }, { status: 400 });
  }

  try {
    const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "@alexjbarnes/cockpit"], {
      timeout: 120_000,
      env: { ...process.env, PATH: process.env.PATH },
      shell: true,
    });
    return NextResponse.json({ ok: true, output: (stdout + "\n" + stderr).trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
