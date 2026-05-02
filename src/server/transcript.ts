import { createReadStream, existsSync, readFileSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { v4 as uuidv4 } from "uuid";
import type {
  ChatMessage,
  ContentBlock,
  DocumentAttachment,
  GlobalSearchResult,
  ImageAttachment,
  SessionGroup,
  SessionInfo,
  TextFileAttachment,
  ToolUse,
} from "@/types";
import { debugLog } from "./debug-logger";

interface TranscriptBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | TranscriptBlock[];
  source?: { type: string; media_type?: string; data?: string };
}

interface TranscriptEntry {
  type: string;
  subtype?: string;
  content?: string;
  cwd?: string;
  timestamp?: string;
  isMeta?: boolean;
  uuid?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | TranscriptBlock[];
    model?: string;
    usage?: { output_tokens?: number };
  };
  parentToolUseID?: string;
  data?: {
    message?: {
      type?: string;
      message?: {
        role?: string;
        content?: string | TranscriptBlock[];
      };
    };
  };
}

function getTranscriptPath(sessionId: string, cwd: string): string {
  const projectKey = cwd.replace(/[/.]/g, "-");
  return path.join(homedir(), ".claude", "projects", projectKey, `${sessionId}.jsonl`);
}

export function transcriptExists(sessionId: string, cwd: string): boolean {
  return existsSync(getTranscriptPath(sessionId, cwd));
}

export function countTranscriptMessages(sessionId: string, cwd: string): number {
  const fp = getTranscriptPath(sessionId, cwd);
  if (!existsSync(fp)) return 0;
  try {
    const raw = readFileSync(fp, "utf-8");
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.includes('"role"') && (line.includes('"assistant"') || line.includes('"user"'))) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

const CLI_XML_RE =
  /<(?:task-notification|local-command-caveat|local-command-stdout|system-reminder)[^>]*>[\s\S]*?<\/(?:task-notification|local-command-caveat|local-command-stdout|system-reminder)>[\s\S]*/g;

const FILE_TAG_RE = /<file\s+path="([^"]+)">\n([\s\S]*?)\n<\/file>/g;

function extractTextFiles(text: string): { cleaned: string; textFiles: TextFileAttachment[] } {
  const textFiles: TextFileAttachment[] = [];
  const cleaned = text
    .replace(FILE_TAG_RE, (_match, name: string, content: string) => {
      textFiles.push({ name, content });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, textFiles };
}

function stripCommandXml(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<task-notification>")) return "";
  if (trimmed.startsWith("<local-command-caveat>")) return "";
  if (trimmed.startsWith("<local-command-stdout>")) return "";
  if (trimmed.startsWith("<command-name>")) {
    const match = trimmed.match(/<command-name>(\/[^<]+)<\/command-name>/);
    if (match) {
      if (match[1] === "/compact") return "";
      return match[1];
    }
  }
  return text;
}

function stripCliXml(text: string): string {
  return text.replace(CLI_XML_RE, "").trim();
}

const INITIAL_CHUNK_SIZE = 64 * 1024; // 64KB

async function readTailLines(filePath: string, targetCount: number): Promise<{ lines: string[]; byteOffset: number; totalSize: number }> {
  const fileStat = await stat(filePath);
  const totalSize = fileStat.size;
  if (totalSize === 0) return { lines: [], byteOffset: 0, totalSize };

  let chunkSize = INITIAL_CHUNK_SIZE;
  const fh = await open(filePath, "r");
  try {
    while (true) {
      const readSize = Math.min(chunkSize, totalSize);
      const offset = totalSize - readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, offset);
      const text = buf.toString("utf-8");

      // Split into lines, discard partial first line if we didn't read from start
      let lines: string[];
      if (offset > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) {
          // Entire chunk is one partial line, need a bigger chunk
          if (chunkSize >= totalSize) {
            lines = [text];
          } else {
            chunkSize *= 2;
            continue;
          }
        } else {
          lines = text.slice(firstNewline + 1).split(/\r?\n/);
        }
      } else {
        lines = text.split(/\r?\n/);
      }

      lines = lines.filter((l) => l.trim());

      if (lines.length >= targetCount || offset === 0) {
        // Take only the last targetCount lines
        const result = lines.length > targetCount ? lines.slice(-targetCount) : lines;
        // Calculate byte offset of the first returned line
        // We approximate by finding position in the chunk text
        const returnedText = result.join("\n");
        const byteOffset = Math.max(0, offset + (text.length - returnedText.length - (text.endsWith("\n") ? 1 : 0)));
        return { lines: result, byteOffset: offset === 0 ? 0 : byteOffset, totalSize };
      }

      // Not enough lines, double chunk and retry
      chunkSize *= 2;
    }
  } finally {
    await fh.close();
  }
}

export async function readMoreLines(
  filePath: string,
  byteOffset: number,
  targetCount: number,
): Promise<{ lines: string[]; newByteOffset: number }> {
  if (byteOffset <= 0) return { lines: [], newByteOffset: 0 };

  let chunkSize = INITIAL_CHUNK_SIZE;
  const fh = await open(filePath, "r");
  try {
    while (true) {
      const readSize = Math.min(chunkSize, byteOffset);
      const offset = byteOffset - readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, offset);
      const text = buf.toString("utf-8");

      let lines: string[];
      if (offset > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) {
          if (chunkSize >= byteOffset) {
            lines = [text];
          } else {
            chunkSize *= 2;
            continue;
          }
        } else {
          lines = text.slice(firstNewline + 1).split(/\r?\n/);
        }
      } else {
        lines = text.split(/\r?\n/);
      }

      lines = lines.filter((l) => l.trim());

      if (lines.length >= targetCount || offset === 0) {
        const result = lines.length > targetCount ? lines.slice(-targetCount) : lines;
        const returnedText = result.join("\n");
        const newByteOffset = Math.max(0, offset + (text.length - returnedText.length - (text.endsWith("\n") ? 1 : 0)));
        return { lines: result, newByteOffset: offset === 0 ? 0 : newByteOffset };
      }

      chunkSize *= 2;
    }
  } finally {
    await fh.close();
  }
}

export async function loadLastUsage(sessionId: string, cwd: string): Promise<{ used: number; total: number } | null> {
  const fp = getTranscriptPath(sessionId, cwd);
  if (!existsSync(fp)) return null;

  const raw = await readFile(fp, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  let lastUsage: { used: number; total: number } | null = null;
  let contextWindowSize = 200_000;

  // Scan backwards for the most recent result event with modelUsage to get contextWindow
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "result" && entry.modelUsage) {
        for (const model of Object.values(entry.modelUsage) as Record<string, number>[]) {
          if (model.contextWindow && model.contextWindow > 0) {
            contextWindowSize = model.contextWindow;
            break;
          }
        }
        break;
      }
    } catch {}
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "assistant" && entry.message?.usage) {
        const u = entry.message.usage;
        const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        lastUsage = { used, total: contextWindowSize };
        break;
      }
    } catch {}
  }
  return lastUsage;
}

export interface TranscriptResult {
  messages: ChatMessage[];
  byteOffset: number;
  totalSize: number;
  lastUsage: { used: number; total: number } | null;
}

function parseLines(lines: string[]): { messages: ChatMessage[]; lastUsage: { used: number; total: number } | null } {
  const messages: ChatMessage[] = [];
  const messageById = new Map<string, ChatMessage>();
  const toolUseMap = new Map<string, ToolUse>();
  let lastUserOrToolResultTs = 0;
  let lastUsage: { used: number; total: number } | null = null;
  let contextWindowSize = 200_000;

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract usage data as we parse
    if (entry.type === "result") {
      const modelUsage = (entry as unknown as Record<string, unknown>).modelUsage as Record<string, Record<string, number>> | undefined;
      if (modelUsage) {
        for (const model of Object.values(modelUsage)) {
          if (model.contextWindow && model.contextWindow > 0) {
            contextWindowSize = model.contextWindow;
            break;
          }
        }
      }
      continue;
    }
    if (entry.type === "assistant" && entry.message) {
      const usage = (entry.message as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (usage) {
        const used = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        lastUsage = { used, total: contextWindowSize };
      }
    }

    // Attach sub-agent tool calls as children of their parent Agent tool
    if (entry.type === "progress" && entry.parentToolUseID) {
      const parentTool = toolUseMap.get(entry.parentToolUseID);
      if (!parentTool) continue;

      const innerMsg = entry.data?.message;
      const content = innerMsg?.message?.content;
      if (!innerMsg || !Array.isArray(content)) continue;

      if (innerMsg.type === "assistant") {
        if (!parentTool.children) parentTool.children = [];
        for (const block of content) {
          if (block.type === "tool_use") {
            const child: ToolUse = {
              id: block.id || uuidv4(),
              name: block.name || "unknown",
              input: block.input ? JSON.stringify(block.input) : "",
              output: "",
              status: "done",
            };
            parentTool.children.push(child);
            toolUseMap.set(child.id, child);
          }
        }
      } else if (innerMsg.type === "user") {
        for (const tr of content) {
          if (tr.type !== "tool_result") continue;
          const tool = toolUseMap.get(tr.tool_use_id || "");
          if (tool) {
            tool.output = extractOutput(tr);
            tool.status = "done";
          }
        }
      }

      continue;
    }

    // Skip meta messages (slash command caveats, etc.)
    if (entry.isMeta) continue;

    if (entry.type === "system" && entry.subtype === "local_command" && entry.content) {
      const rawContent = entry.content as string;
      const match = rawContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      const text = match ? match[1].trim() : rawContent;
      if (text) {
        messages.push({
          id: entry.uuid || uuidv4(),
          role: "assistant",
          content: text,
          toolUses: [],
          blocks: [{ type: "text", text }],
          timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
        });
      }
      continue;
    }

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      messages.push({
        id: "compact-" + uuidv4(),
        role: "system",
        content: "__compacted__",
        toolUses: [],
        blocks: [],
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
      });
      continue;
    }

    if (entry.type === "user" && entry.message) {
      if (entry.timestamp) lastUserOrToolResultTs = new Date(entry.timestamp).getTime();
      const content = entry.message.content;

      if (typeof content === "string") {
        const stripped = stripCommandXml(content);
        if (stripped) {
          const { cleaned, textFiles } = extractTextFiles(stripped);
          if (cleaned || textFiles.length > 0) {
            messages.push({
              id: entry.message.id || uuidv4(),
              role: "user",
              content: cleaned,
              toolUses: [],
              blocks: [],
              timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
              textFiles: textFiles.length > 0 ? textFiles : undefined,
            });
          }
        }
        continue;
      }

      if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === "tool_result");
        for (const tr of toolResults) {
          const toolId = tr.tool_use_id || "";
          const tool = toolUseMap.get(toolId);
          if (tool) {
            tool.output = extractOutput(tr);
            tool.status = "done";
          }
        }

        const imageBlocks = content.filter(
          (b) => b.type === "image" && b.source?.type === "base64" && b.source.media_type && b.source.data,
        );
        const images: ImageAttachment[] = imageBlocks.map((b) => ({
          mediaType: b.source!.media_type as ImageAttachment["mediaType"],
          data: b.source!.data as string,
        }));

        const docBlocks = content.filter(
          (b) => b.type === "document" && b.source?.type === "base64" && b.source.media_type === "application/pdf" && b.source.data,
        );
        const documents: DocumentAttachment[] = docBlocks.map((b) => ({
          mediaType: "application/pdf" as const,
          data: b.source!.data as string,
          name: "document.pdf",
        }));

        const textParts = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!);
        const userText = textParts.join("\n");

        if (images.length > 0 || documents.length > 0 || (userText && toolResults.length === 0)) {
          const stripped = userText ? stripCommandXml(userText) : "";
          const { cleaned, textFiles } = extractTextFiles(stripped);
          if (images.length > 0 || documents.length > 0 || cleaned || textFiles.length > 0) {
            messages.push({
              id: entry.message.id || uuidv4(),
              role: "user",
              content: cleaned,
              toolUses: [],
              blocks: [],
              timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
              images: images.length > 0 ? images : undefined,
              documents: documents.length > 0 ? documents : undefined,
              textFiles: textFiles.length > 0 ? textFiles : undefined,
            });
          }
        }
      }
    }

    if (entry.type === "assistant" && entry.message) {
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      const toolUses: ToolUse[] = [];
      const blocks: ContentBlock[] = [];
      let textContent = "";

      const msgId = entry.message.id || uuidv4();
      const entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      const hasThinking = content.some((b) => b.type === "thinking" && (b.thinking || b.signature));

      let thinkingDurationMs: number | undefined;
      if (hasThinking && lastUserOrToolResultTs && entryTs > lastUserOrToolResultTs) {
        thinkingDurationMs = entryTs - lastUserOrToolResultTs;
      }

      for (const block of content) {
        if (block.type === "thinking") {
          const redacted = !block.thinking && !!block.signature;
          if (!block.thinking && !redacted) continue;
          blocks.push({ type: "thinking", text: block.thinking ?? "", durationMs: thinkingDurationMs, redacted });
        } else if (block.type === "text" && block.text) {
          const cleaned = stripCliXml(block.text);
          if (cleaned) {
            textContent += cleaned;
            blocks.push({ type: "text", text: cleaned });
          }
        } else if (block.type === "tool_use") {
          const tool: ToolUse = {
            id: block.id || uuidv4(),
            name: block.name || "unknown",
            input: block.input ? JSON.stringify(block.input) : "",
            output: "",
            status: "done",
          };
          toolUses.push(tool);
          blocks.push({ type: "tool_use", toolUse: tool });
          toolUseMap.set(tool.id, tool);
        }
      }

      const trimmed = textContent.trim();
      if (toolUses.length === 0 && (trimmed === "No response requested." || /^API Error: \d+\s/.test(trimmed))) {
        continue;
      }

      const existing = entry.message.id ? messageById.get(msgId) : undefined;
      if (existing) {
        if (textContent) existing.content += textContent;
        for (const tu of toolUses) {
          if (!existing.toolUses.some((t) => t.id === tu.id)) {
            existing.toolUses.push(tu);
          }
        }
        for (const b of blocks) {
          if (b.type === "tool_use") {
            if (existing.blocks.some((eb) => eb.type === "tool_use" && eb.toolUse.id === b.toolUse.id)) continue;
          }
          existing.blocks.push(b);
        }
      } else {
        const msg: ChatMessage = {
          id: msgId,
          role: "assistant",
          content: textContent,
          toolUses,
          blocks,
          timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
          model: typeof entry.message.model === "string" ? entry.message.model : undefined,
        };
        messages.push(msg);
        messageById.set(msgId, msg);
      }
    }
  }

  return { messages, lastUsage };
}

const TAIL_LINES = 150;
const _PAGE_SIZE = 50;

export async function loadTranscript(sessionId: string, cwd: string, options?: { tailLines?: number }): Promise<TranscriptResult> {
  const fp = getTranscriptPath(sessionId, cwd);
  if (!existsSync(fp)) return { messages: [], byteOffset: 0, totalSize: 0, lastUsage: null };

  const t0 = performance.now();
  const tailCount = options?.tailLines;

  let lines: string[];
  let byteOffset: number;
  let totalSize: number;
  let readLabel: string;

  if (tailCount) {
    const result = await readTailLines(fp, tailCount);
    lines = result.lines;
    byteOffset = result.byteOffset;
    totalSize = result.totalSize;
    readLabel = `tail(${tailCount})`;
  } else {
    const raw = await readFile(fp, "utf-8");
    lines = raw.split(/\r?\n/).filter((l) => l.trim());
    byteOffset = 0;
    totalSize = raw.length;
    readLabel = "full";
  }
  const tRead = performance.now();

  const { messages, lastUsage } = parseLines(lines);
  const tParse = performance.now();

  const sid = sessionId.slice(0, 8);
  debugLog(
    `[transcript:${sid}] ${readLabel}: ${lines.length} lines, ${messages.length} msgs | read=${(tRead - t0).toFixed(0)}ms parse=${(tParse - tRead).toFixed(0)}ms total=${(tParse - t0).toFixed(0)}ms`,
  );

  return { messages, byteOffset, totalSize, lastUsage };
}

export async function loadMoreMessages(
  sessionId: string,
  cwd: string,
  byteOffset: number,
  targetLines?: number,
): Promise<{ messages: ChatMessage[]; newByteOffset: number }> {
  if (byteOffset <= 0) return { messages: [], newByteOffset: 0 };

  const fp = getTranscriptPath(sessionId, cwd);
  const t0 = performance.now();
  const { lines, newByteOffset } = await readMoreLines(fp, byteOffset, targetLines || TAIL_LINES);
  const tRead = performance.now();

  const { messages } = parseLines(lines);
  const tParse = performance.now();

  const sid = sessionId.slice(0, 8);
  debugLog(
    `[transcript:${sid}] more: ${lines.length} lines, ${messages.length} msgs | read=${(tRead - t0).toFixed(0)}ms parse=${(tParse - tRead).toFixed(0)}ms`,
  );

  return { messages, newByteOffset };
}

function extractOutput(block: TranscriptBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b.type === "text" && b.text) return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface SessionMeta {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
}

async function extractSessionMeta(filePath: string): Promise<SessionMeta | null> {
  const id = path.basename(filePath, ".jsonl");
  let cwd = "";
  let title = "";
  let createdAt = 0;

  try {
    const fileStat = await stat(filePath);
    const lastActiveAt = fileStat.mtimeMs;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let linesRead = 0;
    for await (const line of rl) {
      if (linesRead > 50) break;
      linesRead++;

      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === "user" && entry.cwd && !cwd) {
        cwd = entry.cwd;
      }

      if (entry.timestamp && !createdAt) {
        createdAt = new Date(entry.timestamp).getTime();
      }

      if (entry.type === "user" && entry.message && !title) {
        const content = entry.message.content;
        let candidate = "";
        if (typeof content === "string") {
          candidate = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b) => b.type === "text" && b.text);
          if (textBlock?.text) candidate = textBlock.text;
        }
        // Skip system-generated messages like [Request interrupted...] and XML tags
        if (candidate && !candidate.startsWith("[") && !candidate.startsWith("<")) {
          title = candidate.slice(0, 120);
        }
      }

      if (cwd && title && createdAt) break;
    }

    rl.close();

    if (!cwd) return null;

    return {
      id,
      cwd,
      title: title || "Untitled session",
      createdAt: createdAt || lastActiveAt,
      lastActiveAt,
    };
  } catch {
    return null;
  }
}

export async function findSessionCwd(sessionId: string): Promise<string | null> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  const filename = `${sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const filePath = path.join(projectsDir, dir, filename);
    if (existsSync(filePath)) {
      const meta = await extractSessionMeta(filePath);
      if (meta?.cwd) return meta.cwd;
      return null;
    }
  }
  return null;
}

export async function scanAllSessions(): Promise<SessionGroup[]> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const allMeta: SessionMeta[] = [];

  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    const metas = await Promise.all(jsonlFiles.map((f) => extractSessionMeta(path.join(dirPath, f))));

    for (const meta of metas) {
      if (meta) allMeta.push(meta);
    }
  }

  const groups = new Map<string, SessionInfo[]>();

  for (const meta of allMeta) {
    const sessions = groups.get(meta.cwd) || [];
    sessions.push({
      id: meta.id,
      name: meta.title,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
      status: "idle",
    });
    groups.set(meta.cwd, sessions);
  }

  const result: SessionGroup[] = [];
  for (const [cwd, sessions] of groups) {
    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    result.push({
      cwd,
      dirName: path.basename(cwd) || cwd,
      sessions,
      totalSessionCount: sessions.length,
    });
  }

  result.sort((a, b) => {
    const aLatest = a.sessions[0]?.lastActiveAt || 0;
    const bLatest = b.sessions[0]?.lastActiveAt || 0;
    return bLatest - aLatest;
  });

  return result;
}

function metaToSessionInfo(meta: SessionMeta): SessionInfo {
  return {
    id: meta.id,
    name: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
    status: "idle",
  };
}

export async function scanSessionsForCwd(targetCwd: string): Promise<SessionInfo[]> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const results: SessionInfo[] = [];

  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    const metas = await Promise.all(jsonlFiles.map((f) => extractSessionMeta(path.join(dirPath, f))));

    for (const meta of metas) {
      if (meta && meta.cwd === targetCwd) {
        results.push(metaToSessionInfo(meta));
      }
    }
  }

  results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return results;
}

export async function scanSessionsByIds(ids: string[]): Promise<SessionInfo[]> {
  if (ids.length === 0) return [];
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const idSet = new Set(ids);
  const results: SessionInfo[] = [];

  for (const dir of projectDirs) {
    if (idSet.size === 0) break;
    const dirPath = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    const matching = files.filter((f) => f.endsWith(".jsonl") && idSet.has(f.slice(0, -".jsonl".length)));
    if (matching.length === 0) continue;

    const metas = await Promise.all(matching.map((f) => extractSessionMeta(path.join(dirPath, f))));
    for (const meta of metas) {
      if (meta) {
        results.push(metaToSessionInfo(meta));
        idSet.delete(meta.id);
      }
    }
  }

  return results;
}

interface TranscriptFileInfo {
  filePath: string;
  sessionId: string;
  mtimeMs: number;
}

export async function listAllTranscriptFiles(): Promise<TranscriptFileInfo[]> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const results: TranscriptFileInfo[] = [];

  for (const dir of projectDirs) {
    if (dir.includes(".cockpit")) continue;
    const dirPath = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, f);
      try {
        const s = await stat(filePath);
        results.push({ filePath, sessionId: f.slice(0, -6), mtimeMs: s.mtimeMs });
      } catch {}
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

export async function globalSearch(
  query: string,
  limit: number,
  offset = 0,
): Promise<{ results: GlobalSearchResult[]; totalFilesSearched: number; truncated: boolean }> {
  const MAX_FILES = 500;
  const MAX_PARSED_BASE = 30;
  const MAX_PER_FILE = 10;
  const effectiveLimit = Math.min(limit, 100);
  const lowerQuery = query.toLowerCase();

  // When paginating, allow parsing more files to reach the offset
  const maxParsed = MAX_PARSED_BASE + Math.ceil(offset / MAX_PER_FILE);

  const files = await listAllTranscriptFiles();
  const searchFiles = files.slice(0, MAX_FILES);

  const results: GlobalSearchResult[] = [];
  let totalFound = 0;
  let filesParsed = 0;
  let truncated = false;

  for (const file of searchFiles) {
    if (results.length >= effectiveLimit || filesParsed >= maxParsed) {
      truncated = true;
      break;
    }

    let raw: string;
    try {
      raw = await readFile(file.filePath, "utf-8");
    } catch {
      continue;
    }

    if (!raw.toLowerCase().includes(lowerQuery)) continue;

    filesParsed++;
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const { messages } = parseLines(lines);

    let cwd = "";
    let sessionTitle = "";
    for (let j = 0; j < Math.min(lines.length, 50); j++) {
      try {
        const entry: TranscriptEntry = JSON.parse(lines[j]);
        if (entry.type === "user" && entry.cwd && !cwd) cwd = entry.cwd;
        if (entry.type === "user" && entry.message && !sessionTitle) {
          const content = entry.message.content;
          let candidate = "";
          if (typeof content === "string") candidate = content;
          else if (Array.isArray(content)) {
            const tb = content.find((b: TranscriptBlock) => b.type === "text" && b.text);
            if (tb?.text) candidate = tb.text;
          }
          if (candidate && !candidate.startsWith("[") && !candidate.startsWith("<")) {
            sessionTitle = candidate.slice(0, 120);
          }
        }
        if (cwd && sessionTitle) break;
      } catch {}
    }

    if (!cwd) continue;
    if (cwd.endsWith(".cockpit/reviews") || cwd.endsWith(".cockpit/jobs")) continue;

    const dirName = path.basename(cwd) || cwd;
    let fileResults = 0;

    for (let i = 0; i < messages.length; i++) {
      if (fileResults >= MAX_PER_FILE || results.length >= effectiveLimit) break;

      const msg = messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      if (i > 0 && messages[i - 1].content === "__compacted__") continue;
      if (i > 1 && messages[i - 2].content === "__compacted__") continue;

      let text = "";
      if (msg.blocks && msg.blocks.length > 0) {
        text = msg.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      if (!text && typeof msg.content === "string") {
        text = msg.content;
      }
      if (!text) continue;

      const matchIndex = text.toLowerCase().indexOf(lowerQuery);
      if (matchIndex === -1) continue;

      totalFound++;
      fileResults++;

      if (totalFound <= offset) continue;

      const previewStart = Math.max(0, matchIndex - 100);
      const previewEnd = Math.min(text.length, matchIndex + query.length + 100);
      let preview = text.slice(previewStart, previewEnd);
      let matchStart = matchIndex - previewStart;

      if (previewStart > 0) {
        preview = "..." + preview;
        matchStart += 3;
      }
      if (previewEnd < text.length) {
        preview = preview + "...";
      }

      results.push({
        sessionId: file.sessionId,
        sessionName: sessionTitle || "Untitled session",
        cwd,
        dirName,
        messageId: msg.id,
        role: msg.role as "user" | "assistant",
        timestamp: msg.timestamp,
        preview,
        matchStart,
        matchLength: query.length,
        fullContent: text.length > 2000 ? text.slice(0, 2000) + "..." : text,
      });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return { results, totalFilesSearched: searchFiles.length, truncated };
}
