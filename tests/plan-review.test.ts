// Plan review's pure halves: what counts as markup, what the agent is sent,
// how a plan is answered, and how versions and drafts are kept.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvedPlanText,
  approvePlan,
  dismissPlan,
  type PlanAnswerExtras,
  planApprovalOptions,
  requestPlanChanges,
} from "@/lib/plan-review/approval";
import {
  formatAnnotations,
  formatPlanFeedback,
  noteFromText,
  PLAN_NOTES_HEADING,
  planWithNotes,
  sortAnnotations,
} from "@/lib/plan-review/feedback";
import { PLAN_LABELS, planLabel } from "@/lib/plan-review/labels";
import { PLAN_MAX_ANNOTATIONS, type PlanAnnotation, sanitizeAnnotations } from "@/lib/plan-review/types";
import {
  deletePlanRecord,
  latestVersion,
  PLAN_MAX_VERSIONS,
  planHash,
  readPlanRecord,
  recordPlanReview,
  recordPlanVersion,
  savePlanDraft,
} from "@/server/plan-review-storage";
import {
  isPlanFilePath,
  PLAN_ANSWER_MAX_CHARS,
  permissionAnswerExtras,
  planFromRequest,
  recordSessionPlanAnswer,
  rememberSessionPlan,
  writePlanFile,
} from "@/server/plans";

function mark(over: Partial<PlanAnnotation> = {}): PlanAnnotation {
  return {
    id: "a1",
    kind: "comment",
    quote: "Create hello.txt",
    prefix: "1. ",
    suffix: "\n2.",
    body: "Which folder?",
    createdAt: 1,
    ...over,
  };
}

let dir: string;
let prevCockpit: string | undefined;
let prevClaude: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-planreview-"));
  prevCockpit = process.env.COCKPIT_CONFIG_DIR;
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = path.join(dir, "cockpit");
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
  mkdirSync(path.join(dir, "claude", "plans"), { recursive: true });
});

afterEach(() => {
  if (prevCockpit === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevCockpit;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeAnnotations", () => {
  it("keeps well-formed markup of every kind", () => {
    const input = [
      mark(),
      mark({ id: "a2", kind: "remove", body: "" }),
      mark({ id: "a3", kind: "replace", body: "Create greeting.txt" }),
      mark({ id: "a4", kind: "note", quote: "ignored", body: "Too long overall" }),
    ];
    const out = sanitizeAnnotations(input);
    expect(out.map((a) => a.kind)).toEqual(["comment", "remove", "replace", "note"]);
    // A note is about the whole plan, so it carries no selection.
    expect(out[3].quote).toBe("");
  });

  it("drops what is not markup rather than repairing it", () => {
    const out = sanitizeAnnotations([
      null,
      "text",
      { id: "", kind: "comment", quote: "x", body: "y" },
      { id: "k", kind: "shout", quote: "x", body: "y" },
      { id: "empty-quote", kind: "remove", quote: "   ", body: "" },
      { id: "silent-comment", kind: "comment", quote: "x", body: "  " },
      { id: "silent-note", kind: "note", quote: "", body: "" },
      mark({ id: "dup" }),
      mark({ id: "dup", body: "second" }),
    ]);
    expect(out.map((a) => a.id)).toEqual(["dup"]);
    expect(out[0].body).toBe("Which folder?");
    expect(sanitizeAnnotations("nope")).toEqual([]);
  });

  it("lets a label stand in for a comment's words", () => {
    const out = sanitizeAnnotations([{ id: "l", kind: "comment", quote: "x", body: "", label: "tests", createdAt: 5 }]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("tests");
  });

  it("keeps only whole positive line numbers and clamps long text", () => {
    const out = sanitizeAnnotations([mark({ lineStart: 3, lineEnd: 0, prefix: "p".repeat(500), createdAt: Number.NaN })]);
    expect(out[0].lineStart).toBe(3);
    expect(out[0].lineEnd).toBeUndefined();
    expect(out[0].prefix).toHaveLength(200);
    expect(Number.isFinite(out[0].createdAt)).toBe(true);
  });

  it("stops at the cap", () => {
    const many = Array.from({ length: PLAN_MAX_ANNOTATIONS + 20 }, (_, i) => mark({ id: `m${i}` }));
    expect(sanitizeAnnotations(many)).toHaveLength(PLAN_MAX_ANNOTATIONS);
  });
});

describe("labels", () => {
  it("finds a label by id and nothing for an unknown one", () => {
    expect(planLabel("tests")?.name).toBe("Needs tests");
    expect(planLabel("nope")).toBeUndefined();
    expect(planLabel(undefined)).toBeUndefined();
    expect(new Set(PLAN_LABELS.map((l) => l.id)).size).toBe(PLAN_LABELS.length);
  });
});

describe("feedback", () => {
  it("orders markup by line, then notes last", () => {
    const sorted = sortAnnotations([
      mark({ id: "note", kind: "note", quote: "", body: "n", createdAt: 0 }),
      mark({ id: "late", lineStart: 9, createdAt: 1 }),
      mark({ id: "unplaced", createdAt: 2 }),
      mark({ id: "early", lineStart: 2, createdAt: 3 }),
      mark({ id: "early-first", lineStart: 2, createdAt: 1 }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["early-first", "early", "late", "unplaced", "note"]);
  });

  it("writes each kind so the agent can act on it", () => {
    const text = formatAnnotations([
      mark({ id: "c", lineStart: 3 }),
      mark({ id: "r", kind: "remove", body: "", lineStart: 5, lineEnd: 7 }),
      mark({ id: "p", kind: "replace", quote: "hello", body: "greeting", lineStart: 8 }),
      mark({ id: "l", kind: "comment", quote: "step two", body: "", label: "tests", lineStart: 9 }),
      mark({ id: "n", kind: "note", quote: "", body: "Split this in two\nphases" }),
    ]);
    expect(text).toContain("1. On this (line 3): `Create hello.txt`\n> Which folder?");
    expect(text).toContain("2. Remove this (lines 5 to 7): `Create hello.txt`");
    expect(text).toContain("3. Replace this (line 8): `hello`\nWith:\n> greeting");
    expect(text).toContain("4. On this (line 9): `step two`\n> Needs tests. Say how this will be tested, and add the tests to the plan.");
    expect(text).toContain("5. About the plan as a whole:\n> Split this in two\n> phases");
  });

  it("fences a selection that would break inline code", () => {
    const multi = formatAnnotations([mark({ quote: "line one\nline two" })]);
    expect(multi).toContain("```\nline one\nline two\n```");
    const ticks = formatAnnotations([mark({ quote: "run ```sh``` here" })]);
    expect(ticks).toContain("````\nrun ```sh``` here\n````");
  });

  it("tells the agent the plan is not approved and what to do", () => {
    const text = formatPlanFeedback([mark()]);
    expect(text).toMatch(/^The user reviewed the plan and asked for changes\. It is not approved\./);
    expect(text).toContain("## Review notes (1)");
    expect(text).not.toContain("own edits");
  });

  it("includes the reviewer's own edits when there are some", () => {
    const text = formatPlanFeedback([], { diff: "-old\n+new\n" });
    expect(text).not.toContain("## Review notes");
    expect(text).toContain("## The user's own edits");
    expect(text).toContain("```diff\n-old\n+new\n```");
    expect(formatPlanFeedback([], { diff: "  " })).not.toContain("own edits");
  });

  it("carries notes inside an approved plan, and leaves a plan with none alone", () => {
    expect(planWithNotes("# Plan\n", [])).toBe("# Plan\n");
    const withNotes = planWithNotes("# Plan\n\n", [mark()]);
    expect(withNotes.startsWith(`# Plan\n\n${PLAN_NOTES_HEADING}\n\n`)).toBe(true);
    expect(withNotes).toContain("Which folder?");
  });

  it("turns typed text into a note about the whole plan", () => {
    expect(noteFromText("Too vague", 7)).toEqual({
      id: "note-7",
      kind: "note",
      quote: "",
      prefix: "",
      suffix: "",
      body: "Too vague",
      createdAt: 7,
    });
  });
});

describe("answering a plan", () => {
  function harness() {
    const calls: string[] = [];
    const answers: Array<{ allowed: boolean; extras?: PlanAnswerExtras }> = [];
    const queue: Array<() => void> = [];
    const deps = {
      respond: (allowed: boolean, extras?: PlanAnswerExtras) => {
        answers.push({ allowed, extras });
        calls.push(allowed ? "allow" : "deny");
      },
      sendMessage: (text: string) => calls.push(`send:${text}`),
      setBypass: (on: boolean) => calls.push(`bypass:${on}`),
      setPlanMode: (on: boolean) => calls.push(`plan:${on}`),
      schedule: (fn: () => void) => {
        queue.push(fn);
      },
    };
    const flush = () => {
      while (queue.length) queue.shift()?.();
    };
    return { calls, answers, deps, flush };
  }

  it("offers four ways to say yes, two under bypass", () => {
    expect(planApprovalOptions(false)).toHaveLength(4);
    expect(planApprovalOptions(true).every((o) => o.autoAccept)).toBe(true);
  });

  it("approves in place with a plain yes", () => {
    const h = harness();
    approvePlan(planApprovalOptions(false)[3], { planContent: "# P" }, h.deps);
    expect(h.calls).toEqual(["allow"]);
    expect(h.answers[0].extras).toEqual({ plan: { outcome: "approved", annotations: [] } });
  });

  it("turns on auto-accept before answering", () => {
    const h = harness();
    approvePlan(planApprovalOptions(false)[2], { planContent: "# P" }, h.deps);
    expect(h.calls).toEqual(["bypass:true", "allow"]);
  });

  it("clears the context by refusing, clearing, then naming the plan file", () => {
    const h = harness();
    approvePlan(planApprovalOptions(false)[1], { planContent: "# P", planFilePath: "/p/plan.md" }, h.deps);
    expect(h.calls).toEqual(["deny", "plan:false"]);
    // A refusal that means yes says so, or it would be kept as a dismissal.
    expect(h.answers[0].extras?.plan?.outcome).toBe("approved");
    h.flush();
    expect(h.calls.slice(2)).toEqual(["send:/clear", "send:Implement the plan at /p/plan.md"]);
  });

  it("names no file when the plan has none", () => {
    const h = harness();
    approvePlan(planApprovalOptions(true)[0], {}, h.deps);
    h.flush();
    expect(h.calls).toContain("send:Implement the plan");
  });

  it("sends the edited plan and the notes as the approved text", () => {
    const h = harness();
    approvePlan(planApprovalOptions(false)[3], { planContent: "# P", editedText: "# P2", annotations: [mark()] }, h.deps);
    expect(h.answers[0].extras?.planText).toContain("# P2");
    expect(h.answers[0].extras?.planText).toContain(PLAN_NOTES_HEADING);
    expect(approvedPlanText({ planContent: "# P" })).toBeUndefined();
    expect(approvedPlanText({ planContent: "# P", editedText: "# P" })).toBeUndefined();
    expect(approvedPlanText({})).toBeUndefined();
  });

  it("sends markup back as the answer to the plan", () => {
    const h = harness();
    requestPlanChanges([mark()], h.deps);
    expect(h.calls).toEqual(["deny"]);
    expect(h.answers[0].extras?.denyMessage).toContain("Which folder?");
    expect(h.answers[0].extras?.plan).toEqual({ outcome: "changes_requested", annotations: [mark()] });
  });

  it("dismisses without a verdict and asks for plan mode again", () => {
    const h = harness();
    dismissPlan(h.deps);
    expect(h.answers[0]).toEqual({ allowed: false, extras: { plan: { outcome: "dismissed" } } });
    h.flush();
    expect(h.calls).toEqual(["deny", "plan:true"]);
  });

  it("falls back to a real timer when none is injected", async () => {
    const calls: string[] = [];
    dismissPlan({ respond: () => calls.push("deny"), sendMessage: () => {}, setBypass: () => {}, setPlanMode: () => calls.push("plan") });
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toEqual(["deny", "plan"]);
  });
});

describe("plan store", () => {
  const session = { kind: "session" as const, id: "sess-1" };

  it("numbers versions and treats identical text as the same version", () => {
    expect(readPlanRecord(session)).toEqual({ versions: [] });
    const first = recordPlanVersion(session, { content: "# One", requestId: "r1", now: 10 });
    expect(first).toMatchObject({ created: true, version: { n: 1, requestId: "r1", createdAt: 10, hash: planHash("# One") } });
    const again = recordPlanVersion(session, { content: "# One", requestId: "r2", planFilePath: "/p.md" });
    expect(again.created).toBe(false);
    // Proposed again: same version, now tied to the new request.
    expect(readPlanRecord(session).versions).toHaveLength(1);
    expect(readPlanRecord(session).versions[0]).toMatchObject({ n: 1, requestId: "r2", planFilePath: "/p.md" });
    const second = recordPlanVersion(session, { content: "# Two", author: { kind: "user" } });
    expect(second.version).toMatchObject({ n: 2, author: { kind: "user" } });
    expect(latestVersion(readPlanRecord(session))?.n).toBe(2);
  });

  it("does not rewrite the file when the same plan arrives with nothing new", () => {
    recordPlanVersion(session, { content: "# One", requestId: "r1" });
    const file = path.join(dir, "cockpit", "plan-reviews", "session-sess-1.json");
    const before = readFileSync(file, "utf-8");
    recordPlanVersion(session, { content: "# One", requestId: "r1" });
    recordPlanVersion(session, { content: "# One" });
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("keeps the newest versions and never reuses a number", () => {
    for (let i = 1; i <= PLAN_MAX_VERSIONS + 3; i++) recordPlanVersion(session, { content: `# v${i}` });
    const { versions } = readPlanRecord(session);
    expect(versions).toHaveLength(PLAN_MAX_VERSIONS);
    expect(versions[0].n).toBe(4);
    expect(versions[versions.length - 1].n).toBe(PLAN_MAX_VERSIONS + 3);
  });

  it("puts a review on its version and clears the draft behind it", () => {
    recordPlanVersion(session, { content: "# One", requestId: "r1" });
    savePlanDraft(session, { version: 1, annotations: [mark()], updatedAt: 5 });
    const reviewed = recordPlanReview(
      session,
      { requestId: "r1" },
      { outcome: "changes_requested", annotations: [mark(), { bad: true } as unknown as PlanAnnotation], feedback: "fix", reviewedAt: 9 },
    );
    expect(reviewed?.review).toMatchObject({ outcome: "changes_requested", feedback: "fix", reviewedAt: 9 });
    expect(reviewed?.review?.annotations).toHaveLength(1);
    expect(readPlanRecord(session).draft).toBeUndefined();
    expect(recordPlanReview(session, { n: 9 }, { outcome: "approved", annotations: [], feedback: "", reviewedAt: 1 })).toBeUndefined();
    expect(
      recordPlanReview(session, { n: 1 }, { outcome: "approved", annotations: [], feedback: "", reviewedAt: 1 })?.review?.outcome,
    ).toBe("approved");
  });

  it("leaves a draft on another version alone when a review lands", () => {
    recordPlanVersion(session, { content: "# One" });
    recordPlanVersion(session, { content: "# Two" });
    savePlanDraft(session, { version: 2, annotations: [mark()], updatedAt: 5 });
    recordPlanReview(session, { n: 1 }, { outcome: "dismissed", annotations: [], feedback: "", reviewedAt: 1 });
    expect(readPlanRecord(session).draft?.version).toBe(2);
  });

  it("saves a draft, refuses an older one, and drops an emptied one", () => {
    recordPlanVersion(session, { content: "# One" });
    const saved = savePlanDraft(session, { version: 1, annotations: [mark()], editedText: "# One!", updatedAt: 10 });
    expect(saved).toMatchObject({ version: 1, hash: planHash("# One"), editedText: "# One!", updatedAt: 10 });
    // A slower save from another device must not undo this one.
    const stale = savePlanDraft(session, { version: 1, annotations: [], updatedAt: 4 });
    expect(stale?.updatedAt).toBe(10);
    // Text edited back to the original is not an edit.
    const unedited = savePlanDraft(session, { version: 1, annotations: [mark()], editedText: "# One", updatedAt: 11 });
    expect(unedited?.editedText).toBeUndefined();
    expect(savePlanDraft(session, { version: 1, annotations: [], updatedAt: 12 })).toBeUndefined();
    expect(readPlanRecord(session).draft).toBeUndefined();
    // Emptying what is already empty is nothing to write.
    expect(savePlanDraft(session, { version: 1, annotations: [], updatedAt: 13 })).toBeUndefined();
  });

  it("ignores a draft for a version that does not exist, and clears on null", () => {
    recordPlanVersion(session, { content: "# One" });
    expect(savePlanDraft(session, { version: 7, annotations: [mark()], updatedAt: 1 })).toBeUndefined();
    savePlanDraft(session, { version: 1, annotations: [mark()], updatedAt: 2 });
    expect(savePlanDraft(session, null)).toBeUndefined();
    expect(readPlanRecord(session).draft).toBeUndefined();
    expect(savePlanDraft(session, null)).toBeUndefined();
  });

  it("keeps an issue's plan apart from a session's, under an upper-case key", () => {
    recordPlanVersion({ kind: "issue", key: "ck-12" }, { content: "# Issue plan" });
    expect(readPlanRecord({ kind: "issue", key: "CK-12" }).versions).toHaveLength(1);
    expect(readPlanRecord(session).versions).toHaveLength(0);
    expect(existsSync(path.join(dir, "cockpit", "plan-reviews", "issue-CK-12.json"))).toBe(true);
    deletePlanRecord({ kind: "issue", key: "CK-12" });
    expect(readPlanRecord({ kind: "issue", key: "CK-12" }).versions).toHaveLength(0);
  });

  it("refuses an id that could not be a file name", () => {
    const bad = { kind: "session" as const, id: "../escape" };
    expect(readPlanRecord(bad)).toEqual({ versions: [] });
    expect(() => recordPlanVersion(bad, { content: "x" })).toThrow();
    expect(() => deletePlanRecord(bad)).not.toThrow();
  });

  it("reads a broken file as no plan", () => {
    const file = path.join(dir, "cockpit", "plan-reviews", "session-sess-1.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(readPlanRecord(session)).toEqual({ versions: [] });
    writeFileSync(file, JSON.stringify({ versions: "nope" }));
    expect(readPlanRecord(session)).toEqual({ versions: [] });
  });
});

describe("a session's plan", () => {
  const plansDir = () => path.join(dir, "claude", "plans");

  it("takes the plan the request itself carries", () => {
    writeFileSync(path.join(plansDir(), "other-session.md"), "# Someone else's");
    const mine = path.join(plansDir(), "mine.md");
    expect(planFromRequest({ plan: "# Mine", planFilePath: mine })).toEqual({ planFilePath: mine, planContent: "# Mine" });
    expect(planFromRequest({ plan: "# Mine" })).toEqual({ planFilePath: undefined, planContent: "# Mine" });
  });

  it("reads the named file when the request carries no text", () => {
    const mine = path.join(plansDir(), "mine.md");
    writeFileSync(mine, "# From disk");
    expect(planFromRequest({ planFilePath: mine, plan: "  " })).toEqual({ planFilePath: mine, planContent: "# From disk" });
  });

  it("falls back to the newest plan file, and to nothing", () => {
    expect(planFromRequest(undefined)).toEqual({});
    writeFileSync(path.join(plansDir(), "latest.md"), "# Latest");
    expect(planFromRequest({})).toEqual({ planFilePath: path.join(plansDir(), "latest.md"), planContent: "# Latest" });
  });

  it("writes only inside the plans folder", () => {
    const inside = path.join(plansDir(), "p.md");
    expect(isPlanFilePath(inside)).toBe(true);
    expect(isPlanFilePath(path.join(plansDir(), "..", "settings.md"))).toBe(false);
    expect(isPlanFilePath(path.join(plansDir(), "p.txt"))).toBe(false);
    expect(isPlanFilePath(undefined)).toBe(false);
    expect(writePlanFile(inside, "# Written")).toBe(true);
    expect(readFileSync(inside, "utf-8")).toBe("# Written");
    expect(writePlanFile(path.join(dir, "elsewhere.md"), "x")).toBe(false);
    expect(existsSync(path.join(dir, "elsewhere.md"))).toBe(false);
    // A path that passes the check but cannot be written.
    expect(writePlanFile(path.join(plansDir(), "missing-dir", "p.md"), "x")).toBe(false);
  });

  it("keeps a proposed plan as a version and says which", () => {
    expect(rememberSessionPlan("s1", "r1", {})).toBeUndefined();
    expect(rememberSessionPlan("s1", "r1", { planContent: "# One", planFilePath: "/x.md" })).toBe(1);
    expect(rememberSessionPlan("s1", "r2", { planContent: "# Two" })).toBe(2);
    expect(rememberSessionPlan("../bad", "r1", { planContent: "# One" })).toBeUndefined();
    expect(readPlanRecord({ kind: "session", id: "s1" }).versions[0].author).toMatchObject({ kind: "session", sessionId: "s1" });
  });

  it("builds the answer's extras per tool and verdict", () => {
    const raw = { allowedPrompts: [] };
    expect(permissionAnswerExtras("Bash", raw, { allowed: false, denyMessage: "no thanks" })).toEqual({
      toolInput: raw,
      denyReason: "no thanks",
    });
    expect(permissionAnswerExtras("Bash", raw, { allowed: false, denyMessage: "   " }).denyReason).toBeUndefined();
    expect(permissionAnswerExtras("Bash", raw, { allowed: false, denyMessage: 5 }).denyReason).toBeUndefined();
    expect(permissionAnswerExtras("ExitPlanMode", raw, { allowed: true, planText: "# Edited" }).toolInput).toEqual({
      allowedPrompts: [],
      plan: "# Edited",
    });
    expect(permissionAnswerExtras("ExitPlanMode", undefined, { allowed: true, planText: "# Edited" }).toolInput).toEqual({
      plan: "# Edited",
    });
    expect(permissionAnswerExtras("ExitPlanMode", raw, { allowed: true }).toolInput).toBe(raw);
    // A plan text on another tool would be a made-up input.
    expect(permissionAnswerExtras("Write", raw, { allowed: true, planText: "# Edited" }).toolInput).toBe(raw);
    const long = permissionAnswerExtras("Bash", raw, { allowed: false, denyMessage: "x".repeat(PLAN_ANSWER_MAX_CHARS + 10) });
    expect(long.denyReason).toHaveLength(PLAN_ANSWER_MAX_CHARS);
  });

  it("records each kind of answer on the version it was about", () => {
    const subject = { kind: "session" as const, id: "s2" };
    const propose = (requestId: string, content: string) => rememberSessionPlan("s2", requestId, { planContent: content });

    propose("r1", "# One");
    recordSessionPlanAnswer(
      "s2",
      { requestId: "r1", planContent: "# One" },
      { allowed: false, denyMessage: "fix it", plan: { annotations: [mark()] } },
      50,
    );
    expect(readPlanRecord(subject).versions[0].review).toMatchObject({ outcome: "changes_requested", feedback: "fix it", reviewedAt: 50 });
    expect(readPlanRecord(subject).versions[0].review?.annotations).toHaveLength(1);

    propose("r2", "# Two");
    recordSessionPlanAnswer("s2", { requestId: "r2", planContent: "# Two" }, { allowed: false });
    expect(readPlanRecord(subject).versions[1].review?.outcome).toBe("dismissed");

    propose("r3", "# Three");
    recordSessionPlanAnswer("s2", { requestId: "r3", planContent: "# Three" }, { allowed: true, plan: { outcome: "nonsense" } });
    expect(readPlanRecord(subject).versions[2].review).toMatchObject({ outcome: "approved", feedback: "" });
  });

  it("keeps an edited approval as a version of its own", () => {
    const subject = { kind: "session" as const, id: "s3" };
    rememberSessionPlan("s3", "r1", { planContent: "# One" });
    recordSessionPlanAnswer("s3", { requestId: "r1", planContent: "# One" }, { allowed: true, planText: "# One, edited" });
    const { versions } = readPlanRecord(subject);
    expect(versions).toHaveLength(2);
    expect(versions[0].review?.outcome).toBe("approved");
    expect(versions[1]).toMatchObject({ n: 2, content: "# One, edited", author: { kind: "user" }, review: { outcome: "approved" } });
  });

  it("writes an edited plan itself when the approval is sent as a refusal", () => {
    const file = path.join(plansDir(), "fresh.md");
    writeFileSync(file, "# One");
    rememberSessionPlan("s4", "r1", { planContent: "# One", planFilePath: file });
    recordSessionPlanAnswer(
      "s4",
      { requestId: "r1", planContent: "# One", planFilePath: file },
      { allowed: false, planText: "# One with notes", plan: { outcome: "approved" } },
    );
    expect(readFileSync(file, "utf-8")).toBe("# One with notes");
    expect(readPlanRecord({ kind: "session", id: "s4" }).versions).toHaveLength(2);
  });

  it("leaves the file to the CLI on an ordinary yes, and ignores text on a refusal", () => {
    const file = path.join(plansDir(), "kept.md");
    writeFileSync(file, "# One");
    rememberSessionPlan("s5", "r1", { planContent: "# One", planFilePath: file });
    recordSessionPlanAnswer("s5", { requestId: "r1", planContent: "# One", planFilePath: file }, { allowed: true, planText: "# Edited" });
    expect(readFileSync(file, "utf-8")).toBe("# One");
    rememberSessionPlan("s5", "r2", { planContent: "# Two", planFilePath: file });
    recordSessionPlanAnswer(
      "s5",
      { requestId: "r2", planContent: "# Two", planFilePath: file },
      { allowed: false, denyMessage: "no", planText: "# Sneaky" },
    );
    expect(readFileSync(file, "utf-8")).toBe("# One");
    // An approval whose text is the plan as proposed adds no version.
    rememberSessionPlan("s5", "r3", { planContent: "# Three" });
    recordSessionPlanAnswer("s5", { requestId: "r3", planContent: "# Three" }, { allowed: true, planText: "# Three" });
    expect(readPlanRecord({ kind: "session", id: "s5" }).versions.map((v) => v.content)).toEqual(["# One", "# Edited", "# Two", "# Three"]);
  });

  it("survives a plan it cannot store", () => {
    expect(() => recordSessionPlanAnswer("../bad", { requestId: "r1" }, { allowed: true, planText: "# x" })).not.toThrow();
  });
});
