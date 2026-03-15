import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ChatMessage, SessionInfo, SessionGroup, ToolUse, ContentBlock, ImageAttachment, DocumentAttachment, TextFileAttachment } from "@/types";
import { v4 as uuidv4 } from "uuid";

interface TranscriptBlock {
  type: string;
  text?: string;
  thinking?: string;
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
  cwd?: string;
  timestamp?: string;
  isMeta?: boolean;
  uuid?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | TranscriptBlock[];
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
  const projectKey = cwd.replace(/\//g, "-");
  return path.join(homedir(), ".claude", "projects", projectKey, `${sessionId}.jsonl`);
}

export function transcriptExists(sessionId: string, cwd: string): boolean {
  return existsSync(getTranscriptPath(sessionId, cwd));
}

const CLI_XML_RE = /<(?:task-notification|local-command-caveat|local-command-stdout|system-reminder)[^>]*>[\s\S]*?<\/(?:task-notification|local-command-caveat|local-command-stdout|system-reminder)>[\s\S]*/g;

const FILE_TAG_RE = /<file\s+path="([^"]+)">\n([\s\S]*?)\n<\/file>/g;

function extractTextFiles(text: string): { cleaned: string; textFiles: TextFileAttachment[] } {
  const textFiles: TextFileAttachment[] = [];
  const cleaned = text.replace(FILE_TAG_RE, (_match, name: string, content: string) => {
    textFiles.push({ name, content });
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
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

export async function loadLastUsage(sessionId: string, cwd: string): Promise<{ used: number; total: number } | null> {
  const fp = getTranscriptPath(sessionId, cwd);
  if (!existsSync(fp)) return null;

  const raw = await readFile(fp, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  let lastUsage: { used: number; total: number } | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "assistant" && entry.message?.usage) {
        const u = entry.message.usage;
        const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        lastUsage = { used, total: 200_000 };
        break;
      }
    } catch {
      continue;
    }
  }
  return lastUsage;
}

export async function loadTranscript(sessionId: string, cwd: string): Promise<ChatMessage[]> {
  const fp = getTranscriptPath(sessionId, cwd);
  if (!existsSync(fp)) return [];

  const raw = await readFile(fp, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const messages: ChatMessage[] = [];
  const messageById = new Map<string, ChatMessage>();
  const toolUseMap = new Map<string, ToolUse>();

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
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
      const content = entry.message.content;

      // Simple text user message
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
              timestamp: Date.now(),
              textFiles: textFiles.length > 0 ? textFiles : undefined,
            });
          }
        }
        continue;
      }

      // Array content - contains tool_results, images, and text blocks
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

        // Extract images from user messages
        const imageBlocks = content.filter(
          (b) => b.type === "image" && b.source?.type === "base64" && b.source.media_type && b.source.data
        );
        const images: ImageAttachment[] = imageBlocks.map((b) => ({
          mediaType: b.source!.media_type as ImageAttachment["mediaType"],
          data: b.source!.data as string,
        }));

        // Extract document (PDF) blocks from user messages
        const docBlocks = content.filter(
          (b) => b.type === "document" && b.source?.type === "base64" && b.source.media_type === "application/pdf" && b.source.data
        );
        const documents: DocumentAttachment[] = docBlocks.map((b) => ({
          mediaType: "application/pdf" as const,
          data: b.source!.data as string,
          name: "document.pdf",
        }));

        // Extract text from user array messages (when attachments are present)
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
              timestamp: Date.now(),
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

      for (const block of content) {
        if (block.type === "thinking" && block.thinking) {
          blocks.push({ type: "thinking", text: block.thinking });
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

      const existing = entry.message.id ? messageById.get(msgId) : undefined;
      if (existing) {
        // Accumulate blocks across streaming entries for the same message
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
          timestamp: Date.now(),
        };
        messages.push(msg);
        messageById.set(msgId, msg);
      }
    }
  }

  return messages;
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
    const metas = await Promise.all(
      jsonlFiles.map((f) => extractSessionMeta(path.join(dirPath, f)))
    );

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
      dirName: cwd.split("/").pop() || cwd,
      sessions,
    });
  }

  result.sort((a, b) => {
    const aLatest = a.sessions[0]?.lastActiveAt || 0;
    const bLatest = b.sessions[0]?.lastActiveAt || 0;
    return bLatest - aLatest;
  });

  return result;
}
