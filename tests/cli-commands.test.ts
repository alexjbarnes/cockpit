import { describe, expect, it } from "vitest";
import { classifyCliCommand } from "@/lib/cli-commands";

describe("classifyCliCommand", () => {
  it("classifies interactive (local-jsx) commands", () => {
    expect(classifyCliCommand("/mcp")).toBe("local-jsx");
    expect(classifyCliCommand("/config")).toBe("local-jsx");
    expect(classifyCliCommand("/agents")).toBe("local-jsx");
  });

  it("classifies local action commands", () => {
    expect(classifyCliCommand("/compact")).toBe("local");
    expect(classifyCliCommand("/usage")).toBe("local");
  });

  it("classifies model-invoking (prompt) commands", () => {
    expect(classifyCliCommand("/review")).toBe("prompt");
  });

  it("accepts names with or without a leading slash and is case-insensitive", () => {
    expect(classifyCliCommand("mcp")).toBe("local-jsx");
    expect(classifyCliCommand("/MCP")).toBe("local-jsx");
  });

  it("resolves aliases to the canonical command's type", () => {
    expect(classifyCliCommand("/rc")).toBe("local-jsx"); // -> remote-control
    expect(classifyCliCommand("/stats")).toBe("local"); // -> usage
    expect(classifyCliCommand("/bg")).toBe("local-jsx"); // -> background
  });

  it("returns unknown for custom/project/plugin commands not in the map", () => {
    expect(classifyCliCommand("/totally-made-up")).toBe("unknown");
    expect(classifyCliCommand("/deploy")).toBe("unknown");
  });
});
