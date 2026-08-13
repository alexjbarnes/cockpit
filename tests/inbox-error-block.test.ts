// parseErrorBlock decides whether a finished run is recorded as a failure, so
// a false positive costs a retry redoing work that already succeeded. It is
// mocked in tests/job-scheduler.test.ts, which makes this its only real cover.
import { describe, expect, it } from "vitest";
import { parseErrorBlock } from "@/server/inbox";

function block(json: string): string {
  return `Work finished.\n\n\`\`\`cockpit-error\n${json}\n\`\`\``;
}

describe("parseErrorBlock", () => {
  it("reports a genuine failure, with details when given", () => {
    expect(parseErrorBlock(block('{"error":"Tool failed","details":"No permission for Bash"}'))).toEqual({
      error: "Tool failed",
      details: "No permission for Bash",
    });
    expect(parseErrorBlock(block('{"error":"Tool failed"}'))).toEqual({ error: "Tool failed", details: undefined });
  });

  it("ignores a block a successful run emitted anyway", () => {
    // Observed on run e79e7144: the job recorded its verdict, then appended
    // {"error":"none","details":"Task completed successfully"} because the
    // prompt said its final message MUST include the block. The run was marked
    // failed. None of these spellings is an error.
    for (const value of ["none", "None", "  NONE  ", "", "n/a", "null", "nil", "no error", "no errors", "success", "ok"]) {
      expect(
        parseErrorBlock(block(JSON.stringify({ error: value, details: "Task completed successfully" }))),
        `error: ${JSON.stringify(value)}`,
      ).toBeNull();
    }
  });

  it("returns null when there is no block, or its contents are unusable", () => {
    expect(parseErrorBlock("All done, nothing to report.")).toBeNull();
    expect(parseErrorBlock(block("not json at all"))).toBeNull();
    expect(parseErrorBlock(block('{"details":"missing the error field"}'))).toBeNull();
    expect(parseErrorBlock(block('{"error":123}'))).toBeNull();
  });
});
