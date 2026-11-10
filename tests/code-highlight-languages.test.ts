import { isSupportedLanguage } from "@pierre/highlights";
import { describe, expect, it } from "vitest";
import { aliasedLanguage, EXT_TO_LANG } from "@/lib/code-highlight";

describe("Pierre highlight languages", () => {
  it("supports every language our file extensions map to", () => {
    const languages = [...new Set(Object.values(EXT_TO_LANG))];
    const missing = languages.filter((language) => !isSupportedLanguage(aliasedLanguage(language)));
    expect(missing).toEqual([]);
  });
});
