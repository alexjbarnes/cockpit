import { describe, expect, it } from "vitest";
import { TtlCache } from "@/server/ttl-cache";

/** A cache on a clock the test moves by hand, so expiry costs no waiting. */
function clocked() {
  let now = 1_000_000;
  return {
    cache: new TtlCache<string>(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("TtlCache", () => {
  it("hands back what it was given", () => {
    const { cache } = clocked();
    cache.set("a", "one", 1_000);
    expect(cache.get("a")).toBe("one");
  });

  it("has nothing for a key it never saw", () => {
    const { cache } = clocked();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires an entry when its ttl is reached, and not a moment before", () => {
    const { cache, advance } = clocked();
    cache.set("a", "one", 1_000);

    advance(999);
    expect(cache.get("a")).toBe("one");

    advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size, "reading it after expiry drops it").toBe(0);
  });

  it("drops one key without touching its neighbours", () => {
    const { cache } = clocked();
    cache.set("a", "one", 1_000);
    cache.set("b", "two", 1_000);

    cache.delete("a");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("two");
  });

  it("drops a family by prefix, and only that family", () => {
    const { cache } = clocked();
    cache.set("prs:o/r:open", "1", 1_000);
    cache.set("prs:o/r:closed", "2", 1_000);
    cache.set("pr:o/r:1", "3", 1_000);

    cache.deleteByPrefix("prs:o/r:");

    expect(cache.get("prs:o/r:open")).toBeUndefined();
    expect(cache.get("prs:o/r:closed")).toBeUndefined();
    expect(cache.get("pr:o/r:1"), "a longer key that merely starts the same is not matched").toBe("3");
  });

  it("clears everything at once", () => {
    const { cache } = clocked();
    cache.set("a", "one", 1_000);
    cache.set("b", "two", 1_000);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
