import { describe, expect, it } from "vitest";
import { CONTEXT_SIZES, DEFAULT_CONTEXT_SIZE } from "@/lib/models";

describe("CONTEXT_SIZES env-var mapping", () => {
  it("200k disables 1M context", () => {
    expect(CONTEXT_SIZES["200k"].disableEnv).toBe(true);
  });

  it("1m does not disable 1M context", () => {
    expect(CONTEXT_SIZES["1m"].disableEnv).toBe(false);
  });

  it("DEFAULT_CONTEXT_SIZE is 200k", () => {
    expect(DEFAULT_CONTEXT_SIZE).toBe("200k");
  });
});
