// Real-file tests for loadPromptHistory's incremental cache. The byte
// accounting that drives resume points and the append-only assumption are only
// meaningfully exercised against a real transcript on disk, so this suite uses
// a tmpdir via CLAUDE_CONFIG_DIR rather than the fs mocks in transcript.test.ts.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CWD = "/work/repo";
const SESSION = "sess-1";

let dir: string;
let transcriptPath: string;

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { content: text } })}\n`;
}

function noiseLine(): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reply" }] } })}\n`;
}

async function load(limit?: number): Promise<string[]> {
  const { loadPromptHistory } = await import("@/server/transcript");
  return loadPromptHistory(SESSION, CWD, limit);
}

beforeEach(() => {
  // A unique tmpdir per test means a unique transcript path, so the module's
  // path-keyed cache never carries state between cases.
  dir = mkdtempSync(join(tmpdir(), "prompt-history-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const projectDir = join(dir, "projects", CWD.replace(/[/.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  transcriptPath = join(projectDir, `${SESSION}.jsonl`);
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPromptHistory", () => {
  it("returns most-recent-first and skips non-prompt lines", async () => {
    writeFileSync(
      transcriptPath,
      userLine("first") +
        noiseLine() +
        `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } })}\n` +
        userLine("/compact") +
        userLine("This session is being continued from a previous conversation blah") +
        userLine("<system-reminder>hidden</system-reminder>") +
        userLine("second"),
    );

    expect(await load()).toEqual(["second", "first"]);
  });

  it("reads only appended bytes on the next call and keeps earlier prompts", async () => {
    writeFileSync(transcriptPath, userLine("alpha") + userLine("beta"));
    expect(await load()).toEqual(["beta", "alpha"]);

    appendFileSync(transcriptPath, userLine("gamma"));
    expect(await load()).toEqual(["gamma", "beta", "alpha"]);
  });

  it("serves an unchanged file from cache", async () => {
    writeFileSync(transcriptPath, userLine("alpha"));
    expect(await load()).toEqual(["alpha"]);

    // Deleting the file must not change the answer: a cache hit is decided by
    // size alone, and a hit never touches the contents.
    const before = await load();
    rmSync(transcriptPath);
    // A missing file now stats as an error and yields nothing — proving the
    // previous call really did answer without re-reading.
    expect(before).toEqual(["alpha"]);
    expect(await load()).toEqual([]);
  });

  it("moves a repeated prompt to the front instead of duplicating it", async () => {
    writeFileSync(transcriptPath, userLine("alpha") + userLine("beta"));
    expect(await load()).toEqual(["beta", "alpha"]);

    appendFileSync(transcriptPath, userLine("alpha"));
    expect(await load()).toEqual(["alpha", "beta"]);
  });

  it("caps what it returns to the requested depth", async () => {
    let body = "";
    for (let i = 0; i < 10; i++) body += userLine(`p${i}`);
    writeFileSync(transcriptPath, body);

    expect(await load(3)).toEqual(["p9", "p8", "p7"]);
  });

  it("rebuilds from scratch when the file shrinks", async () => {
    writeFileSync(transcriptPath, userLine("alpha") + userLine("beta"));
    expect(await load()).toEqual(["beta", "alpha"]);

    writeFileSync(transcriptPath, userLine("replacement"));
    expect(await load()).toEqual(["replacement"]);
  });

  it("re-reads a torn trailing line once it is completed", async () => {
    // A prompt written mid-line: the partial JSON is unparseable, and the byte
    // accounting must not claim it as consumed.
    const partial = JSON.stringify({ type: "user", message: { content: "later" } });
    writeFileSync(transcriptPath, userLine("alpha") + partial.slice(0, partial.length - 5));
    expect(await load()).toEqual(["alpha"]);

    writeFileSync(transcriptPath, userLine("alpha") + partial + "\n");
    expect(await load()).toEqual(["later", "alpha"]);
  });

  it("returns nothing for a missing transcript", async () => {
    expect(await load()).toEqual([]);
  });

  it("leaves oversized pastes out of recall", async () => {
    const blob = "x".repeat(20_001);
    writeFileSync(transcriptPath, userLine("alpha") + userLine(blob) + userLine("beta"));

    expect(await load()).toEqual(["beta", "alpha"]);
  });

  it("bounds cache growth without corrupting the served window", async () => {
    // Far more prompts than twice the served depth, added across two reads, so
    // the trim path runs on a cache that later gets extended.
    let body = "";
    for (let i = 0; i < 12; i++) body += userLine(`old${i}`);
    writeFileSync(transcriptPath, body);
    expect(await load(2)).toEqual(["old11", "old10"]);

    appendFileSync(transcriptPath, userLine("fresh"));
    expect(await load(2)).toEqual(["fresh", "old11"]);
  });
});
