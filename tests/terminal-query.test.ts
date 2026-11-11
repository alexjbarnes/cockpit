import { describe, expect, it } from "vitest";
import { DA1_RESPONSE, isDa1Response, takeDa1Queries } from "@/lib/terminal-query";

describe("takeDa1Queries", () => {
  it("finds both spellings of the query", () => {
    expect(takeDa1Queries("", "\x1b[c")).toEqual({ queries: 1, pending: "" });
    expect(takeDa1Queries("", "\x1b[0c")).toEqual({ queries: 1, pending: "" });
  });

  it("counts repeated queries", () => {
    expect(takeDa1Queries("", "a\x1b[0cb\x1b[c")).toEqual({ queries: 2, pending: "" });
  });

  it("carries a query split across frames", () => {
    const first = takeDa1Queries("", "\x1b[");
    expect(first).toEqual({ queries: 0, pending: "\x1b[" });
    expect(takeDa1Queries(first.pending, "0c")).toEqual({ queries: 1, pending: "" });
  });

  it("keeps only a partial query at the end", () => {
    expect(takeDa1Queries("", "\x1b[0c\x1b[0")).toEqual({ queries: 1, pending: "\x1b[0" });
    expect(takeDa1Queries("", "\x1b[0c\x1b")).toEqual({ queries: 1, pending: "\x1b" });
  });

  it("ignores unrelated output", () => {
    expect(takeDa1Queries("", "hello\x1b[6n")).toEqual({ queries: 0, pending: "" });
  });

  it("replies with a VT220 ANSI-colour DA1", () => {
    expect(DA1_RESPONSE).toBe("\x1b[?62;22c");
  });

  it("recognises the terminal's own DA1 response", () => {
    expect(isDa1Response("\x1b[?62;22c")).toBe(true);
    expect(isDa1Response("\x1b[?1;2c")).toBe(true);
    expect(isDa1Response("\x1b[12;40R")).toBe(false);
    expect(isDa1Response("\x1b[?25l")).toBe(false);
  });
});
