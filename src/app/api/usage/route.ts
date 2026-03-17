import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/server/auth";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

function readFromKeychain(): string | null {
  try {
    const raw = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${os.userInfo().username}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getOAuthAccessToken(): string | null {
  // Linux: credentials stored in a JSON file
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const raw = fs.readFileSync(credPath, "utf-8");
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken ?? null;
    if (token) return token;
  } catch {
    // fall through to keychain
  }

  // macOS: credentials stored in the system keychain
  if (process.platform === "darwin") {
    return readFromKeychain();
  }

  return null;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = getOAuthAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "No OAuth credentials found" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Anthropic API returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
