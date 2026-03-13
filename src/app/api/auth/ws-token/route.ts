import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/server/auth";

// Returns the token for WebSocket connections.
// Authenticated via httpOnly cookie, returns the token so the client
// can pass it as a query param on the WS upgrade request.
export function GET(req: NextRequest) {
  const token = req.cookies.get("aperture_token")?.value;
  if (!token || !validateToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ token });
}
