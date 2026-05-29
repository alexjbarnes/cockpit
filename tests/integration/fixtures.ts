// Playwright fixture exposing a per-test harness.
//
// Each test gets a fresh cockpit server, mock API, and tmpdir config. The
// fixture also injects the auth cookie before the test body runs so tests
// can navigate directly to authenticated routes.

import { test as base } from "@playwright/test";
import { type Harness, startHarness } from "./harness";

export const test = base.extend<{ harness: Harness }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture syntax
  harness: async ({}, use) => {
    const harness = await startHarness();

    // Set the auth cookie on every context so navigation hits authenticated
    // routes without going through the login UI. COCKPIT_TOKEN bypass
    // accepts this exact token in validateSession().
    await use(harness);

    await harness.stop();
  },

  context: async ({ context, harness }, use) => {
    await context.addCookies([
      {
        name: "cockpit_session",
        value: harness.cockpitToken,
        url: harness.cockpitUrl,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await use(context);
  },
});

export { expect } from "@playwright/test";
