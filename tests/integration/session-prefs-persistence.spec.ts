// session-prefs is compiled into two bundles that both load into the one server
// process: dist/src/server/session-prefs.js behind the SessionManager on
// globalThis, and a Next chunk behind the /api/sessions/[id]/ route handlers.
// Only a real server exercises that boundary — a unit test can imitate it with
// vi.resetModules(), but it cannot prove the two compiled copies converge.
//
// This spec creates a session (SessionManager side, so the dist copy writes) and
// then saves a tab (route-handler side, so the Next copy writes), with the route
// copy deliberately warmed first so its cache predates the create. Before the
// fix the tab write stamped that stale snapshot back and the whole session entry
// disappeared from the file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

interface StoredPrefs {
  name?: string;
  model?: string;
  contextSize?: string;
  thinkingLevel?: string;
  runtime?: string;
  openTabs?: Array<{ type: string; filePath?: string }>;
  activeTabId?: string;
}

function api(harness: Harness, url: string, init?: RequestInit): Promise<Response> {
  return fetch(`${harness.cockpitUrl}${url}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${harness.cockpitToken}`,
      ...(init?.headers ?? {}),
    },
  });
}

function readPrefs(harness: Harness, sessionId: string): StoredPrefs | undefined {
  const file = path.join(harness.configDir, "session-prefs.json");
  return JSON.parse(readFileSync(file, "utf-8"))[sessionId];
}

test("a tab save from the API route keeps the prefs the session manager wrote", async ({ harness }) => {
  // Warm the route bundle's copy of the prefs map before the session exists.
  const warm = await api(harness, "/api/sessions/never-created-id/tabs");
  expect(warm.status).toBe(200);

  const created = await api(harness, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd: harness.configDir, name: "My Session", runtime: "stream" }),
  });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };

  // Everything the session was created with is persisted, not just its runtime,
  // so a restart restores it instead of falling back to the current defaults.
  const onCreate = readPrefs(harness, sessionId);
  expect(onCreate?.name).toBe("My Session");
  expect(onCreate?.model).toBeTruthy();
  expect(onCreate?.contextSize).toBeTruthy();
  expect(onCreate?.thinkingLevel).toBeTruthy();
  expect(onCreate?.runtime).toBe("stream");

  const saved = await api(harness, `/api/sessions/${sessionId}/tabs`, {
    method: "PUT",
    body: JSON.stringify({ openTabs: [{ type: "file", filePath: "README.md" }], activeTabId: "tab-1" }),
  });
  expect(saved.status).toBe(200);

  const afterTabSave = readPrefs(harness, sessionId);
  expect(afterTabSave?.name).toBe("My Session");
  expect(afterTabSave?.model).toBe(onCreate?.model);
  expect(afterTabSave?.thinkingLevel).toBe(onCreate?.thinkingLevel);
  expect(afterTabSave?.openTabs).toEqual([{ type: "file", filePath: "README.md" }]);
  expect(afterTabSave?.activeTabId).toBe("tab-1");

  // The tab save landing on top of the create is only possible if the route copy
  // re-read the file first, so this covers both directions of the convergence.
  const tabsBack = (await (await api(harness, `/api/sessions/${sessionId}/tabs`)).json()) as StoredPrefs;
  expect(tabsBack.openTabs).toEqual([{ type: "file", filePath: "README.md" }]);
});
