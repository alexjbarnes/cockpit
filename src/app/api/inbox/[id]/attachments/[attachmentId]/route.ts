import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getInboxMessage } from "@/server/inbox";
import { inboxImagePath } from "@/server/inbox-images";
import { getInboxAttachmentsRoot } from "@/server/paths";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Serve a picture attached to an inbox message. Only files under the inbox
 * attachments root are servable, and the path is derived from the message's
 * own image id and a known mime, so a crafted message record cannot read
 * another file off the box.
 */
export function GET(req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id, attachmentId }) => {
    const message = getInboxMessage(id);
    const image = message?.images?.find((candidate) => candidate.id === attachmentId);
    if (!message || !image) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const target = inboxImagePath(id, image);
    if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const root = path.resolve(getInboxAttachmentsRoot());
    const resolved = path.resolve(target);
    if (!resolved.startsWith(root + path.sep)) {
      return NextResponse.json({ error: "Attachment is not a served file" }, { status: 404 });
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return NextResponse.json({ error: "File no longer exists" }, { status: 404 });
    }

    const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "Content-Type": image.mime,
        "Content-Length": String(statSync(resolved).size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}
