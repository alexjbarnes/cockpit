import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

const MAX_BYTES = 100 * 1024; // 100KB
const BINARY_CHECK_BYTES = 8192;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024; // 25MB

// Browser-renderable image types, keyed by lowercase extension.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".apng": "image/apng",
};

function imageMediaType(filePath: string): string | null {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

function authenticate(req: NextRequest): boolean {
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
  const mtimeMs = info.mtimeMs;

  if (url.searchParams.get("stat") === "true") {
    return NextResponse.json({ mtimeMs, size });
  }

  const mediaType = imageMediaType(resolved);

  // Stream raw bytes for image previews: the file viewer's <img src> points here
  // with raw=true. Restricted to known image types so this can't serve arbitrary
  // files inline. The CSP/sandbox headers neutralise scripts in an SVG opened
  // directly; rendered inside <img> they never execute anyway.
  if (url.searchParams.get("raw") === "true") {
    if (!mediaType) {
      return NextResponse.json({ error: "Not an image" }, { status: 400 });
    }
    if (size > IMAGE_MAX_BYTES) {
      return NextResponse.json({ error: "Image too large" }, { status: 413 });
    }
    const bytes = await readFile(resolved);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": mediaType,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Image files report their type so the viewer renders an <img> instead of
  // falling into binary detection (images contain null bytes and would otherwise
  // show "Binary file").
  if (mediaType) {
    return NextResponse.json({ content: "", size, truncated: false, binary: false, image: true, mediaType, mtimeMs });
  }

  const fh = await open(resolved, "r");
  try {
    // Binary detection: scan first 8KB for null bytes
    const checkSize = Math.min(size, BINARY_CHECK_BYTES);
    const checkBuf = Buffer.alloc(checkSize);
    await fh.read(checkBuf, 0, checkSize, 0);
    if (checkBuf.includes(0)) {
      return NextResponse.json({ content: "", size, truncated: false, binary: true, mtimeMs });
    }

    // Read up to MAX_BYTES
    const readSize = Math.min(size, MAX_BYTES);
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, 0);
    const content = buf.toString("utf-8");
    const truncated = size > MAX_BYTES;

    return NextResponse.json({ content, size, truncated, binary: false, mtimeMs });
  } finally {
    await fh.close();
  }
}
