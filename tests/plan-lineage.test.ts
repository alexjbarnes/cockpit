// Telling one plan's revisions from a different plan: a session keeps every
// plan it proposes in one numbered list, and only revisions are compared.

import { describe, expect, it } from "vitest";
import { isRevision, planRoots, planTitle } from "@/lib/plan-review/lineage";

const annotator = [
  "# Plan review: a built-in plan annotator",
  "",
  "## Context",
  "The card shows a read-only plan and a free-text box.",
  "Select text to comment, remove or replace.",
  "Send the markup back as one answer.",
  "Keep each proposal as a numbered version.",
  "Paint highlights without wrapping the text.",
  "Dock the action bar on a phone.",
  "",
  "## Verification",
  "Run the unit tests and the integration spec.",
].join("\n");

const workflows = [
  "# Workflows: issues as a software factory",
  "",
  "## Context",
  "Three scheduled jobs fire on an issue status.",
  "A workflow is an ordered list of stages.",
  "The queue is derived, not stored.",
  "A run starts only while a slot is free.",
  "The server claims the issue, not the agent.",
  "A stalled run flags the issue.",
  "",
  "## Verification",
  "Run the unit tests and the integration spec.",
].join("\n");

describe("planTitle", () => {
  it("is the first top-level heading", () => {
    expect(planTitle("intro\n\n## A section\n# The plan #\n# Later")).toBe("The plan");
    expect(planTitle(annotator)).toBe("Plan review: a built-in plan annotator");
  });

  it("is empty when the plan has no top-level heading", () => {
    expect(planTitle("just some steps\n- one")).toBe("");
    expect(planTitle("## Context\nwords")).toBe("");
    expect(planTitle("#hashtag is not a heading")).toBe("");
  });
});

describe("isRevision", () => {
  it("takes the same title as the same plan, however much was rewritten", () => {
    expect(isRevision(annotator, "# plan review: A built-in plan annotator\n\nAll new text.")).toBe(true);
  });

  it("takes a retitled plan as the same plan when most of it is kept", () => {
    const retitled = annotator.replace("# Plan review: a built-in plan annotator", "# Annotating plans").replace("Send the", "Post the");
    expect(isRevision(annotator, retitled)).toBe(true);
  });

  it("does not link two plans that share only stock headings and a line", () => {
    expect(isRevision(annotator, workflows)).toBe(false);
    expect(isRevision(workflows, annotator)).toBe(false);
  });

  it("does not link plans with no title and nothing in common", () => {
    expect(isRevision("do this\nthen that", "something else\nentirely")).toBe(false);
  });

  it("does not link on headings alone", () => {
    expect(isRevision("## Context\n## Risks", "## Context\n## Risks")).toBe(false);
    expect(isRevision("", "# A plan\nwith a line")).toBe(false);
  });

  it("links untitled plans that keep their lines", () => {
    expect(isRevision("step one\nstep two\nstep three", "step one\nstep two\nstep four")).toBe(true);
  });
});

describe("planRoots", () => {
  it("gives every version the number its plan started at", () => {
    const versions = [
      { n: 3, content: annotator },
      { n: 4, content: `${annotator}\nOne more step.` },
      { n: 5, content: workflows },
      { n: 6, content: `${workflows}\nOne more stage.` },
      { n: 7, content: annotator },
    ];
    expect(planRoots(versions)).toEqual([3, 3, 5, 5, 7]);
  });

  it("is empty for no versions and one plan for one version", () => {
    expect(planRoots([])).toEqual([]);
    expect(planRoots([{ n: 1, content: annotator }])).toEqual([1]);
  });
});
