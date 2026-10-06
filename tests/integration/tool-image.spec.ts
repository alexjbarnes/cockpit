// An image a tool returned reaches the model through the format proxy.
//
// On the OpenAI wire an image cannot ride inside a tool message, so the proxy
// moves it into the user turn that follows. Before that, a Read of a screenshot
// was flattened to the literal text "[object Object]" and the model saw
// nothing. This drives the real CLI's Read tool over a real PNG and asserts on
// what the upstream OpenAI door actually received.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import { ZEN_TEST_MODEL } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

test.use({ harnessOptions: { zenViaMock: true } });

/** A 4x4 red PNG: enough for the Read tool to answer with an image block. */
const RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP8z4AATAxEcQAz0QEHOoQ+uAAAAABJRU5ErkJggg==";

test("an image the Read tool returns reaches the model as an image part", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-toolimage-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const imagePath = path.join(workDir, "shot.png");
    writeFileSync(imagePath, Buffer.from(RED_PNG_BASE64, "base64"));

    // Built before setScript, which resets the builder's id sequence.
    const readTurn = toolUseResponse("Read", { file_path: imagePath });
    const answer = textResponse("Done reading it.");

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: `zen:${ZEN_TEST_MODEL}` },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);

    harness.mock.setScript([{ events: readTurn }]);
    await input.fill(`Read the image at ${imagePath} and tell me what colour it is.`);
    await page.getByTestId("btn-send").click();

    // The turn after the Read carries the tool result, so the translated
    // request the upstream receives is the one to inspect.
    harness.mock.setScript([{ events: answer }]);

    const imageRequests = () =>
      harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/chat/completions" && String(r.body).includes("image_url"));

    await expect.poll(() => imageRequests().length, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(0);

    const body = JSON.parse(imageRequests().at(-1)?.body ?? "{}") as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const serialised = JSON.stringify(body.messages);
    expect(serialised).toContain("data:image/png;base64,");
    expect(serialised).not.toContain("[object Object]");
    // The image rides in a user message; the tool message that points at it
    // carries only text.
    const withImage = body.messages.filter((m) => JSON.stringify(m.content ?? "").includes("data:image/png;base64,"));
    expect(withImage.every((m) => m.role === "user")).toBe(true);
    expect(body.messages.some((m) => m.role === "tool" && typeof m.content === "string")).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
