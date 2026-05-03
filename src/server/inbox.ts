import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { InboxMessage, InboxPriority } from "@/types";
import { dispatchNotification } from "./notifications";

const INBOX_DIR = path.join(homedir(), ".cockpit");
const INBOX_FILE = path.join(INBOX_DIR, "inbox.jsonl");

function ensureDir() {
  if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
}

function readAll(): InboxMessage[] {
  if (!existsSync(INBOX_FILE)) return [];
  const raw = readFileSync(INBOX_FILE, "utf-8");
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
  writeFileSync(INBOX_FILE, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
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

export function markRead(id: string): boolean {
  const messages = readAll();
  const msg = messages.find((m) => m.id === id);
  if (!msg) return false;
  msg.read = true;
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
