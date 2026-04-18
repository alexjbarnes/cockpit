import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";
import { getSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd, loadTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

interface SearchResult {
  messageId: string;
  role: "user" | "assistant";
  timestamp: number;
  preview: string;
  matchStart: number;
  matchLength: number;
  fullContent: string;
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const q = req.nextUrl.searchParams.get("q") || "";
    if (q.length < 2) {
      return NextResponse.json({ error: "Query must be at least 2 characters" }, { status: 400 });
    }

    let cwd = req.nextUrl.searchParams.get("cwd") || "";
    if (!cwd) {
      const prefs = getSessionPrefs(id);
      const sessionId = prefs?.cliSessionId || id;
      const found = await findSessionCwd(sessionId);
      if (!found) {
        return NextResponse.json({ error: "Could not determine cwd" }, { status: 400 });
      }
      cwd = found;
    }

    const prefs = getSessionPrefs(id);
    const cliSessionIds: string[] = [...(prefs?.previousCliSessionIds || []), ...(prefs?.cliSessionId ? [prefs.cliSessionId] : [id])];

    const transcripts = await Promise.all(cliSessionIds.map((sid) => loadTranscript(sid, cwd)));

    const query = q.toLowerCase();
    const results: SearchResult[] = [];

    for (const transcript of transcripts) {
      const msgs = transcript.messages;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        // Skip compaction summaries (first user + assistant messages after a compact boundary)
        if (i > 0 && msgs[i - 1].content === "__compacted__") continue;
        if (i > 1 && msgs[i - 2].content === "__compacted__") continue;

        let text = "";
        if (msg.blocks && msg.blocks.length > 0) {
          text = msg.blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
        }
        if (!text && typeof msg.content === "string") {
          text = msg.content;
        }
        if (!text) continue;

        const lowerText = text.toLowerCase();
        const matchIndex = lowerText.indexOf(query);
        if (matchIndex === -1) continue;

        const previewStart = Math.max(0, matchIndex - 100);
        const previewEnd = Math.min(text.length, matchIndex + q.length + 100);
        let preview = text.slice(previewStart, previewEnd);
        let matchStart = matchIndex - previewStart;

        if (previewStart > 0) {
          preview = "..." + preview;
          matchStart += 3;
        }
        if (previewEnd < text.length) {
          preview = preview + "...";
        }

        results.push({
          messageId: msg.id,
          role: msg.role as "user" | "assistant",
          timestamp: msg.timestamp,
          preview,
          matchStart,
          matchLength: q.length,
          fullContent: text,
        });
      }
    }

    results.sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ results });
  });
}
