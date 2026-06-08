import { describe, expect, it } from "vitest";
import { extractTextFiles } from "@/lib/paste-detect";

describe("extractTextFiles", () => {
  it("extracts a single file block and returns cleaned text", () => {
    const result = extractTextFiles('<file path="paste.ts">\nconst x = 1\n</file>\n\nreview this');
    expect(result.cleaned).toBe("review this");
    expect(result.textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });

  it("returns input as cleaned when no file block is present", () => {
    const result = extractTextFiles("  just some text  ");
    expect(result.cleaned).toBe("just some text");
    expect(result.textFiles).toEqual([]);
  });

  it("handles a file block with no trailing text", () => {
    const result = extractTextFiles('<file path="data.txt">\nhello world\n</file>');
    expect(result.cleaned).toBe("");
    expect(result.textFiles).toEqual([{ name: "data.txt", content: "hello world" }]);
  });

  it("extracts two file blocks in order", () => {
    const result = extractTextFiles('<file path="a.ts">\ncontent a\n</file>\n\n<file path="b.ts">\ncontent b\n</file>\n\nsummary');
    expect(result.cleaned).toBe("summary");
    expect(result.textFiles).toEqual([
      { name: "a.ts", content: "content a" },
      { name: "b.ts", content: "content b" },
    ]);
  });
});
