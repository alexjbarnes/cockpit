import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/server/auth";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const token = body.token as string;

  if (!token || !validateToken(token)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("aperture_token", token, {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
