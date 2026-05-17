import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { open as fsOpen, mkdir, rename, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COCKPIT_DIR = path.join(homedir(), ".cockpit");
const PASSWORD_FILE = path.join(COCKPIT_DIR, "password.json");
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 32;

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
    const raw = require("node:fs").readFileSync(PASSWORD_FILE, "utf-8");
    if (!raw.trim()) {
      console.warn("[auth] password.json exists but is empty (likely corrupted by interrupted write)");
      return null;
    }
    const data = JSON.parse(raw) as StoredPassword;
    if (data.hash && data.salt) return data;
    console.warn("[auth] password.json missing hash/salt fields");
    return null;
  } catch (err) {
    console.error("[auth] failed to read password.json:", err);
    return null;
  }
}

let cachedPassword: StoredPassword | null | undefined;

function getStoredPassword(): StoredPassword | null {
  if (cachedPassword === undefined || cachedPassword === null) {
    cachedPassword = readPasswordFile();
  }
  return cachedPassword;
}

export function needsSetup(): boolean {
  if (process.env.COCKPIT_TOKEN) return false;
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
  const tmpFile = `${PASSWORD_FILE}.tmp.${process.pid}.${Date.now()}`;
  const fh = await fsOpen(tmpFile, "w");
  await fh.writeFile(JSON.stringify(data), "utf-8");
  await fh.sync();
  await fh.close();
  await rename(tmpFile, PASSWORD_FILE);
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
// Signed session tokens (stateless, survives server restarts)
//
// Token format: <timestamp_hex>.<hmac_hex>
// The HMAC is computed over the timestamp using the stored password hash
// as the key. Changing the password invalidates all existing tokens.
// ---------------------------------------------------------------------------

function getSigningKey(): string | null {
  const stored = getStoredPassword();
  return stored?.hash ?? null;
}

export function createSession(): string {
  const key = getSigningKey();
  if (!key) return "";
  const timestamp = Date.now().toString(16);
  const hmac = crypto.createHmac("sha256", key).update(timestamp).digest("hex");
  return `${timestamp}.${hmac}`;
}

export function validateSession(token: string): boolean {
  const key = getSigningKey();
  if (!key) return false;

  // Allow bypass via COCKPIT_TOKEN for e2e tests
  if (process.env.COCKPIT_TOKEN && token === process.env.COCKPIT_TOKEN) return true;

  const dot = token.indexOf(".");
  if (dot === -1) return false;

  const timestamp = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = crypto.createHmac("sha256", key).update(timestamp).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

export function destroySession(_token: string): void {
  // No-op: signed tokens are stateless.
  // Token becomes invalid when the password changes.
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
  const token = extractTokenFromRequest(req);
  return token !== null && validateSession(token);
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader("Set-Cookie", `cockpit_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=31536000`);
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `cockpit_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}
