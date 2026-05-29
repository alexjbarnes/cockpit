import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_SIZE, splitLegacyModel } from "@/lib/models";

describe("splitLegacyModel", () => {
  it("returns undefined model and default size for empty input", () => {
    expect(splitLegacyModel(undefined)).toEqual({ model: undefined, contextSize: DEFAULT_CONTEXT_SIZE });
    expect(splitLegacyModel("")).toEqual({ model: undefined, contextSize: DEFAULT_CONTEXT_SIZE });
  });

  it("returns bare modelId and 200k when no suffix is present", () => {
    expect(splitLegacyModel("claude-opus-4-7")).toEqual({ model: "claude-opus-4-7", contextSize: "200k" });
  });

  it("strips [1m] suffix and returns contextSize 1m", () => {
    expect(splitLegacyModel("claude-opus-4-7[1m]")).toEqual({ model: "claude-opus-4-7", contextSize: "1m" });
    expect(splitLegacyModel("sonnet[1m]")).toEqual({ model: "sonnet", contextSize: "1m" });
  });

  it("strips unrecognized brackets and falls back to 200k", () => {
    expect(splitLegacyModel("claude-foo[2m]")).toEqual({ model: "claude-foo", contextSize: "200k" });
  });
});
