import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function getToken(): string {
  return process.env.COCKPIT_TOKEN || "";
}

export function validateToken(candidate: string): boolean {
  const token = getToken();
  if (!candidate || !token) return false;
  if (Buffer.byteLength(candidate) !== Buffer.byteLength(token)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(candidate),
    Buffer.from(token)
  );
}

export function extractTokenFromRequest(req: IncomingMessage): string | null {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check cookie
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)cockpit_token=([^;]+)/);
    if (match) return match[1];
  }

  return null;
}

export function extractTokenFromQuery(url: string): string | null {
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

export function isAuthenticated(req: IncomingMessage): boolean {
  const candidate = extractTokenFromRequest(req);
  return candidate !== null && validateToken(candidate);
}

export function setTokenCookie(res: ServerResponse, tokenValue: string): void {
  res.setHeader(
    "Set-Cookie",
    `cockpit_token=${tokenValue}; HttpOnly; Path=/; SameSite=Strict; Max-Age=31536000`
  );
}

export function clearTokenCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `cockpit_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
  );
}
