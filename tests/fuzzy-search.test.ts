import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "@/lib/fuzzy-search";

interface Named {
  name: string;
  description?: string;
}

describe("fuzzyMatch", () => {
  it("matches subsequence across separator", () => {
    const candidates: Named[] = [{ name: "myorg-review" }];
    const result = fuzzyMatch("review", candidates, (c) => c.name);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("myorg-review");
  });

  it("exact prefix match scores higher than subsequence across separator", () => {
    const candidates: Named[] = [{ name: "myorg-review" }, { name: "review" }];
    const result = fuzzyMatch("review", candidates, (c) => c.name);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("review");
  });

  it("match at start of name ranks higher than match later in name", () => {
    const candidates: Named[] = [{ name: "preview" }, { name: "review" }];
    const result = fuzzyMatch("rev", candidates, (c) => c.name);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("review");
  });

  it("matches non-contiguous subsequence", () => {
    const candidates: Named[] = [{ name: "review" }];
    const result = fuzzyMatch("rvw", candidates, (c) => c.name);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("review");
  });

  it("returns empty array when no match", () => {
    const candidates: Named[] = [{ name: "review" }];
    const result = fuzzyMatch("xyz", candidates, (c) => c.name);
    expect(result).toHaveLength(0);
  });

  it("empty query returns all candidates in original order", () => {
    const candidates: Named[] = [{ name: "a" }, { name: "b" }];
    const result = fuzzyMatch("", candidates, (c) => c.name);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  it("matches via description when name does not match", () => {
    const candidates: Named[] = [{ name: "foo", description: "review things" }];
    const result = fuzzyMatch(
      "review",
      candidates,
      (c) => c.name,
      (c) => c.description,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("foo");
  });

  it("name match ranked above description-only match", () => {
    const candidates: Named[] = [
      { name: "foo", description: "review things" },
      { name: "rev", description: "something else" },
    ];
    const result = fuzzyMatch(
      "rev",
      candidates,
      (c) => c.name,
      (c) => c.description,
    );
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("rev");
    expect(result[1].name).toBe("foo");
  });

  it("is case-insensitive", () => {
    const candidates: Named[] = [{ name: "myorg-review" }];
    const result = fuzzyMatch("REVIEW", candidates, (c) => c.name);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("myorg-review");
  });

  it("handles special regex characters literally", () => {
    const candidates: Named[] = [{ name: "myorg.review" }];
    const result = fuzzyMatch(".", candidates, (c) => c.name);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("myorg.review");
  });

  it("preserves source order on equal scores (stable sort)", () => {
    const candidates: Named[] = [{ name: "aba" }, { name: "aca" }];
    // Both "aba" and "aca" match query "aa" with identical scores
    const result = fuzzyMatch("aa", candidates, (c) => c.name);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("aba");
    expect(result[1].name).toBe("aca");
  });

  it("returns empty array for empty candidate list", () => {
    const candidates: Named[] = [];
    const result = fuzzyMatch("review", candidates, (c) => c.name);
    expect(result).toHaveLength(0);
  });

  it("query longer than candidate name returns no match", () => {
    const candidates: Named[] = [{ name: "abc" }];
    const result = fuzzyMatch("abcd", candidates, (c) => c.name);
    expect(result).toHaveLength(0);
  });
});
