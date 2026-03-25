import crypto from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COCKPIT_DIR = path.join(homedir(), ".cockpit");
const PASSWORD_FILE = path.join(COCKPIT_DIR, "password.json");
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 32;

// ---------------------------------------------------------------------------
// Auth mode
// ---------------------------------------------------------------------------

export function isAuthDisabled(): boolean {
  return process.env.COCKPIT_DISABLE_AUTH === "true";
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// ---------------------------------------------------------------------------
// Password file
// ---------------------------------------------------------------------------

interface StoredPassword {
  hash: string;
  salt: string;
}

function readPasswordFile(): StoredPassword | null {
  if (!existsSync(PASSWORD_FILE)) return null;
  try {
    const raw = require("fs").readFileSync(PASSWORD_FILE, "utf-8");
    const data = JSON.parse(raw) as StoredPassword;
    if (data.hash && data.salt) return data;
    return null;
  } catch {
    return null;
  }
}

let cachedPassword: StoredPassword | null | undefined;

function getStoredPassword(): StoredPassword | null {
  if (cachedPassword === undefined) {
    cachedPassword = readPasswordFile();
  }
  return cachedPassword;
}

export function needsSetup(): boolean {
  if (isAuthDisabled()) return false;
  return getStoredPassword() === null;
}

export async function setupPassword(password: string): Promise<void> {
  await mkdir(COCKPIT_DIR, { recursive: true });
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptHash(password, salt);
  const data: StoredPassword = {
    hash: hash.toString("hex"),
    salt: salt.toString("hex"),
  };
  await writeFile(PASSWORD_FILE, JSON.stringify(data), "utf-8");
  cachedPassword = data;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const stored = getStoredPassword();
  if (!stored) return false;
  const salt = Buffer.from(stored.salt, "hex");
  const hash = await scryptHash(password, salt);
  const storedHash = Buffer.from(stored.hash, "hex");
  if (hash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(hash, storedHash);
}

export async function deletePasswordFile(): Promise<void> {
  if (existsSync(PASSWORD_FILE)) {
    await unlink(PASSWORD_FILE);
  }
  cachedPassword = undefined;
}

// ---------------------------------------------------------------------------
// Session tokens (in-memory, survives Next.js dev hot-reload)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __cockpitSessions?: Set<string> };
if (!g.__cockpitSessions) g.__cockpitSessions = new Set<string>();
const sessions = g.__cockpitSessions;

export function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);
  return token;
}

export function validateSession(token: string): boolean {
  if (isAuthDisabled()) return true;
  return sessions.has(token);
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function extractTokenFromRequest(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)cockpit_session=([^;]+)/);
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
  if (isAuthDisabled()) return true;
  const token = extractTokenFromRequest(req);
  return token !== null && validateSession(token);
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `cockpit_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=31536000`
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `cockpit_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
  );
}
