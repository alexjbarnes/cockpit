import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { getInboxAttachmentsRoot } from "@/server/paths";
import type { InboxImage } from "@/types";

/** Same ceiling as an issue picture: read whole, sent whole to the page. */
export const INBOX_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

const TYPES = [
  { mime: "image/png", ext: ".png" },
  { mime: "image/jpeg", ext: ".jpg" },
  { mime: "image/gif", ext: ".gif" },
  { mime: "image/webp", ext: ".webp" },
] as const;

const EXT_BY_MIME = new Map<string, string>(TYPES.map((type) => [type.mime, type.ext]));

/** The type is taken from the bytes, not the URL or a response header: both
 *  are caller-controlled, and a PNG header on HTML would still be rendered as
 *  a picture by a browser that trusts the header. No SVG: opened by its own
 *  address it runs its scripts on Cockpit's origin. */
function sniffImage(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", ext: ".png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", ext: ".webp" };
  }
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const value = ip.toLowerCase();
  if (value === "::" || value === "::1") return true;
  // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
  if (/^fe[89ab]/.test(value) || /^f[cd]/.test(value) || /^ff/.test(value)) return true;
  // A mapped IPv4 address is private exactly when the address it maps is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // Hex-form mapped addresses are unusual in a URL; refuse rather than parse.
  if (value.startsWith("::ffff:")) return true;
  return false;
}

/**
 * Only a public http(s) host may be fetched. This is the guard that stops a
 * caller naming `http://169.254.169.254/` or a service on the LAN: the server
 * fetches this URL itself, so an unchecked one is an SSRF.
 *
 * The hostname is resolved and every address checked before each request. A
 * resolver that changes its answer between this check and the request could
 * still win a race; the callers here are authenticated Cockpit callers, not
 * arbitrary internet traffic.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Image URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URLs must use http or https");
  }
  if (url.username || url.password) throw new Error("Image URLs cannot carry credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Image URLs must use port 80 or 443");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.toLowerCase() === "localhost") throw new Error("Image host is not allowed");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error(`Image host could not be resolved: ${host}`);
  if (addresses.some((address) => isPrivateAddress(address.address))) {
    throw new Error("Image host resolves to a private or local address");
  }
  return url;
}

async function readCapped(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error("Image response had no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("Image is larger than 20 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function downloadImage(raw: string): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Image redirect had no location");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > INBOX_IMAGE_MAX_BYTES) throw new Error("Image is larger than 20 MB");
    const buffer = await readCapped(response, INBOX_IMAGE_MAX_BYTES);
    const sniffed = sniffImage(buffer);
    if (!sniffed) throw new Error("The URL did not return a supported image (png, jpeg, gif or webp)");
    return { buffer, ...sniffed };
  }
  throw new Error("Image redirected too many times");
}

/** Download and store the pictures for one message. The message id is the
 *  directory, so every file belongs to exactly one message; a failure removes
 *  the partial directory rather than leaving orphans behind. */
export async function downloadInboxImages(messageId: string, urls: readonly string[]): Promise<InboxImage[]> {
  const wanted = urls.map((url) => url.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  if (wanted.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images can be attached to one message`);
  const dir = path.join(getInboxAttachmentsRoot(), messageId);
  mkdirSync(dir, { recursive: true });
  const images: InboxImage[] = [];
  try {
    for (const url of wanted) {
      const { buffer, mime, ext } = await downloadImage(url);
      const id = randomUUID();
      writeFileSync(path.join(dir, `${id}${ext}`), buffer, { mode: 0o600 });
      images.push({ id, mime });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return images;
}

/** Where a stored image lives. Only known mimes map to a path, so a crafted
 *  message record cannot steer the serving route at another file. */
export function inboxImagePath(messageId: string, image: InboxImage): string | null {
  const ext = EXT_BY_MIME.get(image.mime);
  if (!ext) return null;
  return path.join(getInboxAttachmentsRoot(), messageId, `${image.id}${ext}`);
}

export function removeInboxImages(messageId: string): void {
  rmSync(path.join(getInboxAttachmentsRoot(), messageId), { recursive: true, force: true });
}

export function clearInboxImages(): void {
  rmSync(getInboxAttachmentsRoot(), { recursive: true, force: true });
}
