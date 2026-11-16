// A person attaching a picture or file to an issue from the page. The agent
// path goes through the MCP tool, which names a file already on disk; here the
// bytes arrive in the request, so they are written into the issue's own
// attachment folder and recorded as an ordinary attachment.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { INLINE_IMAGE_EXTENSIONS } from "@/lib/markdown-images";
import { validateSession } from "@/server/auth";
import { INLINE_IMAGE_MAX_BYTES } from "@/server/issue-images";
import { addIssueAttachment, getIssue, saveIssue } from "@/server/issue-storage";
import { getIssueAttachmentsRoot } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** What a person may attach: the pictures a comment can show, plus documents
 *  the serving route already knows how to hand back. No SVG: opened by its
 *  address it would run its scripts on Cockpit's own origin. */
const ALLOWED_EXTENSIONS = new Set([...INLINE_IMAGE_EXTENSIONS, ".pdf", ".txt"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key } = await params;
  const existing = getIssue(key);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A file is required" }, { status: 400 });
  }

  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type "${ext || "none"}": attach ${[...ALLOWED_EXTENSIONS].join(", ")}` },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The file is empty" }, { status: 400 });
  }
  if (file.size > INLINE_IMAGE_MAX_BYTES) {
    return NextResponse.json({ error: "Files are limited to 20 MB" }, { status: 400 });
  }

  // The stored name is a fresh id, so nothing the uploader called the file can
  // steer where it lands; the original name is kept only as the title.
  const dir = join(getIssueAttachmentsRoot(), key.toUpperCase());
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}${ext}`);
  writeFileSync(dest, Buffer.from(await file.arrayBuffer()));

  const before = new Set(existing.attachments.map((a) => a.id));
  const updated = addIssueAttachment(existing, { title: file.name, url: dest, inline: form?.get("inline") === "1" }, { kind: "user" });
  try {
    saveIssue(updated);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save attachment" }, { status: 400 });
  }

  return NextResponse.json({ issue: updated, attachment: updated.attachments.find((a) => !before.has(a.id)) }, { status: 201 });
}
