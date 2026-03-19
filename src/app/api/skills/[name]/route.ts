import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("cockpit_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function resolveSkillDir(name: string, scope: string, cwd?: string | null): string | null {
  if (!NAME_RE.test(name)) return null;
  if (scope === "user") {
    return path.join(homedir(), ".claude", "skills", name);
  }
  if (scope === "project" && cwd) {
    return path.join(cwd, ".claude", "skills", name);
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "user";
  const cwd = url.searchParams.get("cwd");

  const skillDir = resolveSkillDir(name, scope, cwd);
  if (!skillDir) {
    return NextResponse.json({ error: "Invalid skill name or scope" }, { status: 400 });
  }

  try {
    const content = await readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    return NextResponse.json({ name, scope, content });
  } catch {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const body = await req.json();
  const { scope, cwd, content } = body as { scope: string; cwd?: string; content: string };

  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const skillDir = resolveSkillDir(name, scope, cwd);
  if (!skillDir) {
    return NextResponse.json({ error: "Invalid skill name or scope" }, { status: 400 });
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");

  return NextResponse.json({ ok: true, name, scope });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "user";
  const cwd = url.searchParams.get("cwd");

  const skillDir = resolveSkillDir(name, scope, cwd);
  if (!skillDir) {
    return NextResponse.json({ error: "Invalid skill name or scope" }, { status: 400 });
  }

  try {
    await rm(skillDir, { recursive: true });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
}
