import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { isDirectoryTrusted, trustDirectory } from "@/server/workspace-trust";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Grant the CLI's workspace trust for a directory, on the user's explicit
 * click.
 *
 * The CLI refuses to open an untrusted directory and asks in a TUI dialog
 * cockpit cannot answer, so a session there dies at spawn. Its own error text
 * names this as the alternative: "accept the trust dialog here once
 * interactively, or set projects[dir].hasTrustDialogAccepted".
 *
 * Unfenced by design, unlike the job-scratchpad path that decides for itself:
 * this only ever runs because a person pressed the button on the session that
 * could not start, and they are the one making the call.
 */
export function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return req.json().then((body: { cwd?: unknown }) => {
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const added = trustDirectory(cwd);
    // Already-trusted is a success, not a no-op failure: a double click, or a
    // grant that raced the CLI writing its own entry, should still let the
    // client move on and retry the session.
    const trusted = added || isDirectoryTrusted(cwd);
    if (!trusted) {
      return NextResponse.json({ error: "Could not record trust for this directory" }, { status: 500 });
    }
    return NextResponse.json({ trusted: true, added });
  });
}
