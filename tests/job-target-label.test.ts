import { describe, expect, it } from "vitest";
import { describeJobTargets } from "@/lib/job-target-label";

const NAMES: Record<string, string> = {
  "id-a": "Weekend Things Todo",
  "id-b": "Tech roundup",
  "id-c": "Idea generator",
  "id-d": "Weekly organiser",
};
const lookup = (id: string) => NAMES[id];

describe("describeJobTargets", () => {
  it("names a single job from an id, which is what run_job and stop_job send", () => {
    expect(describeJobTargets({ id: "id-a" }, lookup)).toBe("Weekend Things Todo");
  });

  it("names jobs from the ids array run_job and delete_job accept", () => {
    expect(describeJobTargets({ ids: ["id-a", "id-b"] }, lookup)).toBe("Weekend Things Todo, Tech roundup");
  });

  it("names jobs from the updates array update_job accepts", () => {
    const input = { updates: [{ id: "id-b", enabled: false }, { id: "id-c" }] };
    expect(describeJobTargets(input, lookup)).toBe("Tech roundup, Idea generator");
  });

  it("summarises past two names rather than listing every job", () => {
    expect(describeJobTargets({ ids: ["id-a", "id-b", "id-c", "id-d"] }, lookup)).toBe("Weekend Things Todo, Tech roundup and 2 more");
  });

  it("counts a job once when the same id arrives twice", () => {
    expect(describeJobTargets({ id: "id-a", ids: ["id-a"] }, lookup)).toBe("Weekend Things Todo");
  });

  it("drops an id that no longer resolves instead of showing the raw uuid", () => {
    expect(describeJobTargets({ ids: ["id-a", "9f2c-gone"] }, lookup)).toBe("Weekend Things Todo");
    expect(describeJobTargets({ id: "9f2c-gone" }, lookup)).toBeUndefined();
  });

  it("returns undefined when there is no id to resolve, as on create_job", () => {
    expect(describeJobTargets({ name: "new job" }, lookup)).toBeUndefined();
    expect(describeJobTargets({}, lookup)).toBeUndefined();
  });

  it("tolerates input that is not an object or carries wrong-typed ids", () => {
    expect(describeJobTargets(undefined, lookup)).toBeUndefined();
    expect(describeJobTargets(null, lookup)).toBeUndefined();
    expect(describeJobTargets("id-a", lookup)).toBeUndefined();
    expect(describeJobTargets({ id: 42 }, lookup)).toBeUndefined();
    expect(describeJobTargets({ ids: [42, "id-a", null] }, lookup)).toBe("Weekend Things Todo");
    expect(describeJobTargets({ updates: [null, { enabled: true }, { id: "id-b" }] }, lookup)).toBe("Tech roundup");
  });
});
