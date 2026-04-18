import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

const MAX_BYTES = 100 * 1024; // 100KB
const BINARY_CHECK_BYTES = 8192;

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const resolved = await realpath(path.resolve(rawPath)).catch(() => null);
  if (!resolved) {
    return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
  }

  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    return NextResponse.json({ error: "Path is not a file" }, { status: 400 });
  }

  const size = info.size;

  const fh = await open(resolved, "r");
  try {
    // Binary detection: scan first 8KB for null bytes
    const checkSize = Math.min(size, BINARY_CHECK_BYTES);
    const checkBuf = Buffer.alloc(checkSize);
    await fh.read(checkBuf, 0, checkSize, 0);
    if (checkBuf.includes(0)) {
      return NextResponse.json({ content: "", size, truncated: false, binary: true });
    }

    // Read up to MAX_BYTES
    const readSize = Math.min(size, MAX_BYTES);
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, 0);
    const content = buf.toString("utf-8");
    const truncated = size > MAX_BYTES;

    return NextResponse.json({ content, size, truncated, binary: false });
  } finally {
    await fh.close();
  }
}
