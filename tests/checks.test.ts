import { describe, expect, it } from "vitest";
import { checkOutcome, type PrCheck, tallyChecks } from "@/lib/checks";

function check(bucket: string, name = bucket): PrCheck {
  return { name, state: bucket.toUpperCase(), bucket, link: `https://example.test/${name}` };
}

describe("checkOutcome", () => {
  it("reads gh's buckets as the three states the header counts", () => {
    expect(checkOutcome("pass")).toBe("pass");
    expect(checkOutcome("skipping")).toBe("pass");
    expect(checkOutcome("fail")).toBe("fail");
    expect(checkOutcome("cancel")).toBe("fail");
    expect(checkOutcome("pending")).toBe("pending");
  });

  it("treats anything it does not recognise as still moving, not as a pass", () => {
    expect(checkOutcome("")).toBe("pending");
    expect(checkOutcome("something-new")).toBe("pending");
  });
});

describe("tallyChecks", () => {
  it("counts each check once", () => {
    const checks = [check("pass"), check("pass"), check("skipping"), check("fail"), check("cancel"), check("pending")];

    expect(tallyChecks(checks)).toEqual({ passing: 3, failing: 2, pending: 1 });
  });

  it("has nothing to say about no checks", () => {
    expect(tallyChecks([])).toEqual({ passing: 0, failing: 0, pending: 0 });
  });
});
