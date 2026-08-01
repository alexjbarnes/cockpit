import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getIssue } from "@/server/issue-storage";
import { getIssueAttachmentsRoot } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

/**
 * Serve a locally-stored attachment file. Only files under
 * getIssueAttachmentsRoot() are servable — an attachment url is
 * caller-supplied data (a session or job wrote it through the MCP tool), so
 * treating it as a readable path without containment would let an issue
 * attachment read arbitrary files off the box. Remote (http) attachment urls
 * never reach this route; the UI links them directly.
 */
export function GET(req: NextRequest, { params }: { params: Promise<{ key: string; id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ key, id }) => {
    const issue = getIssue(key);
    const attachment = issue?.attachments.find((a) => a.id === id);
    if (!issue || !attachment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const root = path.resolve(getIssueAttachmentsRoot());
    const target = path.resolve(attachment.url);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return NextResponse.json({ error: "Attachment is not a served file" }, { status: 404 });
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      return NextResponse.json({ error: "File no longer exists" }, { status: 404 });
    }

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
    return new NextResponse(stream, {
      headers: { "Content-Type": type, "Content-Length": String(statSync(target).size) },
    });
  });
}
