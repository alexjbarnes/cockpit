// Unit tests for the shared atomic JSON write helper. Mocks node:fs (mirroring
// session-prefs.test.ts's convention for this exact mechanic) because what's
// under test is the *call sequence* — tmp path written, then renamed onto the
// target — not the content of any real file. A real-disk test can't tell
// "wrote via tmp-then-rename" apart from "truncated the target in place":
// both produce the same successful end state, and only the sequence itself
// tells you which one you got.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);

describe("writeJsonAtomic", () => {
  beforeEach(() => {
    vi.resetModules();
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
  });

  it("mkdir -p's the parent directory before writing", async () => {
    const { writeJsonAtomic } = await import("@/server/atomic-write");
    writeJsonAtomic("/cockpit/projects.json", { a: 1 });
    expect(mockMkdirSync).toHaveBeenCalledWith("/cockpit", { recursive: true });
  });

  it("writes to a tmp-<pid> path, never to the target path directly", async () => {
    const { writeJsonAtomic } = await import("@/server/atomic-write");
    writeJsonAtomic("/cockpit/projects.json", { a: 1 });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [writtenPath, contents] = mockWriteFileSync.mock.calls[0];
    expect(writtenPath).not.toBe("/cockpit/projects.json");
    expect(writtenPath).toBe(`/cockpit/projects.json.tmp-${process.pid}`);
    expect(contents).toBe(JSON.stringify({ a: 1 }, null, 2) + "\n");
  });

  it("renames the tmp path onto the target after writing it, leaving nothing tmp-named behind", async () => {
    const { writeJsonAtomic } = await import("@/server/atomic-write");
    writeJsonAtomic("/cockpit/projects.json", { a: 1 });

    expect(mockRenameSync).toHaveBeenCalledOnce();
    const [from, to] = mockRenameSync.mock.calls[0];
    expect(to).toBe("/cockpit/projects.json");
    // The exact path written is the exact path renamed away: nothing named
    // `.tmp-*` is left dangling once the call returns successfully.
    expect(from).toBe(mockWriteFileSync.mock.calls[0][0]);

    // And the write must precede the rename — a crash before this point in
    // real life leaves only the original target, untouched, never a
    // truncated one.
    const writeOrder = mockWriteFileSync.mock.invocationCallOrder[0];
    const renameOrder = mockRenameSync.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it("serialises as pretty-printed JSON with a trailing newline, matching the rest of the repo's stored JSON", async () => {
    const { writeJsonAtomic } = await import("@/server/atomic-write");
    const value = { nested: { value: [1, 2] } };
    writeJsonAtomic("/cockpit/x.json", value);
    const contents = mockWriteFileSync.mock.calls[0][1] as string;
    expect(contents).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it("propagates a rename failure instead of silently succeeding", async () => {
    mockRenameSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const { writeJsonAtomic } = await import("@/server/atomic-write");
    expect(() => writeJsonAtomic("/cockpit/x.json", {})).toThrow("EACCES");
  });
});
