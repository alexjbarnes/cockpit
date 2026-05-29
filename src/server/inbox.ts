import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getCockpitDir } from "@/server/paths";
import type { InboxMessage, InboxPriority } from "@/types";
import { dispatchNotification } from "./notifications";

function inboxDir(): string {
  return getCockpitDir();
}
function inboxFile(): string {
  return path.join(inboxDir(), "inbox.jsonl");
}

function ensureDir() {
  if (!existsSync(inboxDir())) mkdirSync(inboxDir(), { recursive: true });
}

function readAll(): InboxMessage[] {
  if (!existsSync(inboxFile())) return [];
  const raw = readFileSync(inboxFile(), "utf-8");
  const messages: InboxMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }
  return messages;
}

function writeAll(messages: InboxMessage[]) {
  ensureDir();
  writeFileSync(inboxFile(), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

export function getInboxMessages(): InboxMessage[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function getUnreadCount(): number {
  return readAll().filter((m) => !m.read).length;
}

export function addInboxMessage(msg: {
  title: string;
  body: string;
  priority?: InboxPriority;
  jobId?: string;
  jobName?: string;
  runId?: string;
  notifyProviders?: string[];
}): InboxMessage {
  const messages = readAll();
  const entry: InboxMessage = {
    id: uuidv4(),
    title: msg.title,
    body: msg.body,
    priority: msg.priority || "info",
    jobId: msg.jobId,
    jobName: msg.jobName,
    runId: msg.runId,
    createdAt: Date.now(),
    read: false,
  };
  messages.push(entry);
  writeAll(messages);
  dispatchNotification({
    title: entry.title,
    body: entry.body,
    priority: entry.priority,
    source: "inbox",
    url: `/inbox/${entry.id}`,
    providerIds: msg.notifyProviders,
  });
  return entry;
}

export function markRead(id: string, read = true): boolean {
  const messages = readAll();
  const msg = messages.find((m) => m.id === id);
  if (!msg) return false;
  msg.read = read;
  writeAll(messages);
  return true;
}

export function markAllRead(): void {
  const messages = readAll();
  for (const m of messages) m.read = true;
  writeAll(messages);
}

export function deleteInboxMessage(id: string): boolean {
  const messages = readAll();
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  messages.splice(idx, 1);
  writeAll(messages);
  return true;
}

export function clearInbox(): void {
  writeAll([]);
}

const INBOX_BLOCK_RE = /```cockpit-inbox\s*\n([\s\S]*?)\n```/;

export function parseInboxBlock(text: string): { title: string; body: string; priority?: InboxPriority } | null {
  const match = INBOX_BLOCK_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.title !== "string" || typeof parsed.body !== "string") return null;
    return { title: parsed.title, body: parsed.body, priority: parsed.priority };
  } catch {
    return null;
  }
}

const ERROR_BLOCK_RE = /```cockpit-error\s*\n([\s\S]*?)\n```/;

export function parseErrorBlock(text: string): { error: string; details?: string } | null {
  const match = ERROR_BLOCK_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.error !== "string") return null;
    return { error: parsed.error, details: parsed.details };
  } catch {
    return null;
  }
}
