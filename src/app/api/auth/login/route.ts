import { NextRequest, NextResponse } from "next/server";
import { createSession, needsSetup, verifyPassword } from "@/server/auth";

export async function POST(req: NextRequest) {
  if (needsSetup()) {
    return NextResponse.json({ error: "No password configured. Use /api/auth/setup first." }, { status: 400 });
  }

  const body = await req.json();
  const password = body.password as string;

  if (!password || !(await verifyPassword(password))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const session = createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set("cockpit_session", session, {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
