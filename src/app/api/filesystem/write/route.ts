import { randomUUID } from "node:crypto";
import { open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

// A backstop, not the editing limit: the view refuses to edit anything the read
// route had to truncate (100KB), so reaching this means a caller that is not
// the view.
const MAX_BYTES = 1024 * 1024;

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Replace a file's contents. The new text goes to a temporary file beside the
 * target and is renamed over it, so a reader never sees half a file and a crash
 * mid-write leaves the original alone.
 */
async function writeAtomically(target: string, content: string, mode: number): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.cockpit-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    // A file that is a bind mount (a docker -v of a single file, which is how
    // this app's own config lands) cannot be replaced: rename over it is EBUSY,
    // and the mount would still show the old inode anyway. Rewrite it in place
    // instead — one write, not a truncate followed by a write, so a reader sees
    // old content or new content and never an empty middle.
    try {
      await writeInPlace(target, content);
    } catch {
      throw err;
    }
  }
}

async function writeInPlace(target: string, content: string): Promise<void> {
  const handle = await open(target, "r+");
  try {
    const buffer = Buffer.from(content, "utf8");
    await handle.write(buffer, 0, buffer.length, 0);
    await handle.truncate(buffer.length);
  } finally {
    await handle.close();
  }
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rawPath = typeof body?.path === "string" ? body.path : null;
  const content = typeof body?.content === "string" ? body.content : null;
  if (!rawPath || content === null) {
    return NextResponse.json({ error: "path and content are required" }, { status: 400 });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "File is too large to save (1MB)" }, { status: 413 });
  }

  // Only existing regular files: this edits, it does not create, and realpath
  // means a symlink is written through to its target rather than replaced.
  const resolved = await realpath(path.resolve(rawPath)).catch(() => null);
  if (!resolved) {
    return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "Path is not a file" }, { status: 400 });
  }

  // The caller sends the mtime it read, so a file that changed underneath the
  // editor is refused rather than silently overwritten. Absent means "I know,
  // write it anyway", which is what the conflict dialog's Overwrite sends.
  const expected = typeof body?.expectedMtimeMs === "number" ? body.expectedMtimeMs : null;
  if (expected !== null && info.mtimeMs !== expected) {
    return NextResponse.json({ error: "File changed on disk", mtimeMs: info.mtimeMs, size: info.size }, { status: 409 });
  }

  try {
    await writeAtomically(resolved, content, info.mode & 0o777);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return NextResponse.json(
      { error: code === "EACCES" || code === "EPERM" ? "Not allowed to write this file" : "Could not write the file" },
      { status: 500 },
    );
  }

  const after = await stat(resolved).catch(() => null);
  return NextResponse.json({
    ok: true,
    mtimeMs: after?.mtimeMs ?? info.mtimeMs,
    size: after?.size ?? Buffer.byteLength(content, "utf8"),
  });
}
