import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/server/auth";

export function GET(req: NextRequest) {
  const token = req.cookies.get("aperture_token")?.value;
  if (!token || !validateToken(token)) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true });
}
