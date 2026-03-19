import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
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

function resolveCommandPath(name: string, scope: string, cwd?: string | null): string | null {
  if (!NAME_RE.test(name)) return null;
  if (scope === "user") {
    return path.join(homedir(), ".claude", "commands", `${name}.md`);
  }
  if (scope === "project" && cwd) {
    return path.join(cwd, ".claude", "commands", `${name}.md`);
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

  const filePath = resolveCommandPath(name, scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid command name or scope" }, { status: 400 });
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return NextResponse.json({ name, scope, content });
  } catch {
    return NextResponse.json({ error: "Command not found" }, { status: 404 });
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

  const filePath = resolveCommandPath(name, scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid command name or scope" }, { status: 400 });
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");

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

  const filePath = resolveCommandPath(name, scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid command name or scope" }, { status: 400 });
  }

  try {
    await unlink(filePath);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Command not found" }, { status: 404 });
  }
}
