import { NextRequest, NextResponse } from "next/server";
import { createSession, needsSetup, setupPassword } from "@/server/auth";

export async function POST(req: NextRequest) {
  if (!needsSetup()) {
    return NextResponse.json({ error: "Password already configured" }, { status: 400 });
  }

  const body = await req.json();
  const password = body.password as string;

  if (!password || password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  await setupPassword(password);

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
