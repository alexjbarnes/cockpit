// What every session in the tour says. The director reads each request the
// CLI sends to the tour's API and answers with the next line of its session's
// script: a session is recognised by what was said in it, and each step after
// a tool call by the id of the call it answers.

import type { ApiRequest, Director, Reply } from "./mock-api";
import { CHECKOUT_ROUTE } from "./seed";

export const PROMPTS = {
  storefrontHistory: "Card-testing bots are hammering POST /checkout. Where would rate limiting fit?",
  storefrontWork: "Go ahead: 10 requests a minute per customer, and cover it with a test.",
  storefrontSwitch: "Write the PR description for this.",
  storefrontPush: "Commit it and push the branch.",
  apiHistory: "The Stripe webhook sometimes marks an order paid twice. Can you find out why?",
  apiWork: "Make the handler idempotent on the event id, with a test for a retried delivery.",
  docsHistory: "Draft a migration guide for the v2 SDK.",
  docsWork: "Publish it to the docs site.",
  reactHistory: "Plan the React 20 upgrade. Don't change anything yet.",
  readmeHistory: "Tidy the README and fix the broken links.",
  assistant: "Every weekday at 9am, triage new issues in acme-storefront and send me a summary.",
};

export const SESSION_NAMES = {
  storefront: "Rate-limit checkout",
  api: "Stripe webhook double payments",
  docs: "v2 migration guide",
  react: "React 20 upgrade plan",
};

const RATE_LIMIT = `const WINDOW_MS = 60_000;
const LIMIT = 10;

const hits = new Map<string, number[]>();

/** Allows LIMIT checkouts per customer in any rolling minute. */
export function limitCheckout(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.customer.id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    const retryAfter = Math.ceil((recent[0] + WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many checkout attempts. Try again shortly." });
  }
  recent.push(now);
  hits.set(req.customer.id, recent);
  next();
}
`;

const CHECKOUT_OLD = `import { chargeCard } from "../services/payments";

export const checkout = Router();

checkout.post("/checkout", requireCustomer, async (req, res) => {
`;

const CHECKOUT_NEW = `import { chargeCard } from "../services/payments";
import { limitCheckout } from "../lib/rate-limit";

export const checkout = Router();

checkout.post("/checkout", requireCustomer, limitCheckout, async (req, res) => {
`;

const TEST_OLD = `    expect(res.status).toBe(402);
  });
});
`;

const TEST_NEW = `    expect(res.status).toBe(402);
  });

  it("rate limits a customer after 10 requests a minute", async () => {
    for (let i = 0; i < 10; i++) await request.post("/checkout").as("cus_1").send(order);
    const res = await request.post("/checkout").as("cus_1").send(order);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("lets another customer through", async () => {
    const res = await request.post("/checkout").as("cus_2").send(order);
    expect(res.status).toBe(201);
  });
});
`;

if (!CHECKOUT_ROUTE.includes(CHECKOUT_OLD)) throw new Error("the checkout edit no longer matches the seeded route");

/** Tool call ids, so the step after each call can be found. */
const ID = {
  readRoute: "toolu_tour_read_route",
  readAuth: "toolu_tour_read_auth",
  readTest: "toolu_tour_read_test",
  readRoute2: "toolu_tour_read_route_2",
  write: "toolu_tour_write_limiter",
  edit: "toolu_tour_edit_route",
  editTest: "toolu_tour_edit_test",
  test: "toolu_tour_npm_test",
  push: "toolu_tour_git_push",
  readHook: "toolu_tour_read_webhook",
  grep: "toolu_tour_grep_markpaid",
  writeDoc: "toolu_tour_write_guide",
  ask: "toolu_tour_ask_version",
  createJob: "toolu_tour_create_job",
};

const usage = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead });

export const PUSH_COMMAND =
  'git switch -c rate-limit-checkout && git add -A && git commit -qm "Rate-limit checkout" && git push -u origin rate-limit-checkout';

function storefront(req: ApiRequest, root: string): Reply | null {
  const repo = `${root}/acme-storefront`;
  const ids = req.toolResultIds;
  if (ids.includes(ID.push)) {
    return {
      text: "Pushed **rate-limit-checkout** to origin: 4 files changed. It's ready for a pull request.",
      usage: usage(900, 60, 41_000),
    };
  }
  if (req.lastUserText.includes(PROMPTS.storefrontPush)) {
    return {
      text: "Committing on a new branch and pushing it.",
      tools: [{ id: ID.push, name: "Bash", input: { command: PUSH_COMMAND, description: "Commit and push the branch" } }],
      usage: usage(1_100, 90, 40_000),
    };
  }
  if (ids.includes(ID.test)) {
    return {
      text: [
        "Done. Checkout now allows **10 attempts a minute per customer** and answers `429` with a `Retry-After` header after that.",
        "",
        "- `src/lib/rate-limit.ts`: a rolling one-minute window, kept in memory and keyed by customer",
        "- `src/routes/checkout.ts`: the limiter runs after sign-in and before an order is created",
        "- `tests/checkout.test.ts`: the 11th attempt is refused, and another customer still gets through",
        "",
        "All 12 tests pass.",
      ].join("\n"),
      usage: usage(1_200, 260, 38_000),
    };
  }
  if (ids.includes(ID.editTest)) {
    return {
      text: "Now the suite.",
      tools: [{ id: ID.test, name: "Bash", input: { command: "npm test", description: "Run the test suite" } }],
      usage: usage(900, 60, 36_000),
    };
  }
  if (ids.includes(ID.readTest)) {
    return {
      text: "The limiter goes in its own module, so the route only gains one line.",
      tools: [
        { id: ID.write, name: "Write", input: { file_path: `${repo}/src/lib/rate-limit.ts`, content: RATE_LIMIT } },
        {
          id: ID.edit,
          name: "Edit",
          input: { file_path: `${repo}/src/routes/checkout.ts`, old_string: CHECKOUT_OLD, new_string: CHECKOUT_NEW },
        },
        {
          id: ID.editTest,
          name: "Edit",
          input: { file_path: `${repo}/tests/checkout.test.ts`, old_string: TEST_OLD, new_string: TEST_NEW },
        },
      ],
      pace: 18,
      usage: usage(1_600, 820, 33_000),
    };
  }
  if (req.lastUserText.includes(PROMPTS.storefrontWork)) {
    return {
      text: "I'll add a per-customer limiter in front of the checkout handler. First the route and its tests.",
      tools: [
        { id: ID.readRoute2, name: "Read", input: { file_path: `${repo}/src/routes/checkout.ts` } },
        { id: ID.readTest, name: "Read", input: { file_path: `${repo}/tests/checkout.test.ts` } },
      ],
      usage: usage(2_100, 120, 30_000),
    };
  }
  if (req.lastUserText.includes(PROMPTS.storefrontSwitch)) {
    return {
      text: [
        "**Rate-limit checkout**",
        "",
        "Card-testing bots were sending hundreds of checkout attempts a minute. This caps each signed-in customer at **10 attempts in any rolling minute**.",
        "",
        "**Changes**",
        "- New `limitCheckout` middleware in `src/lib/rate-limit.ts`",
        "- `POST /checkout` runs it after `requireCustomer`, before an order is created",
        "- Over the limit: `429 Too Many Requests` with `Retry-After`",
        "",
        "**Testing**",
        "- `npm test`: 12 passed, including two new checkout cases",
        "",
        "Closes **SHOP-12**.",
      ].join("\n"),
      pace: 22,
      usage: usage(3_400, 310, 0),
    };
  }
  if (ids.includes(ID.readRoute)) {
    return {
      text: [
        "It belongs in `src/routes/checkout.ts`, between `requireCustomer` and the handler:",
        "",
        "1. **After sign-in**, so the limit can be per customer. The bots rotate IP addresses but reuse accounts.",
        "2. **Before `createOrder`**, so a refused attempt costs nothing and never reaches the payment provider.",
        "",
        "A rolling one-minute window kept in memory is enough while there is one server. Say the word and I'll add it with a test.",
      ].join("\n"),
      usage: usage(1_800, 240, 22_000),
    };
  }
  if (req.lastUserText.includes(PROMPTS.storefrontHistory)) {
    return {
      text: "Let me look at the checkout route and how customers are identified.",
      tools: [
        { id: ID.readRoute, name: "Read", input: { file_path: `${repo}/src/routes/checkout.ts` } },
        { id: ID.readAuth, name: "Read", input: { file_path: `${repo}/src/lib/auth.ts` } },
      ],
      usage: usage(1_400, 90, 18_000),
    };
  }
  return null;
}

function api(req: ApiRequest, root: string): Reply | null {
  const repo = `${root}/acme-api`;
  if (req.lastUserText.includes(PROMPTS.apiWork)) {
    // Still working when the tour looks at it.
    return { text: "Adding a processed-events table keyed by the Stripe event id.", delayMs: 15 * 60 * 1000 };
  }
  if (req.toolResultIds.includes(ID.grep)) {
    return {
      text: "Found it. Stripe retries a delivery when the first one is slow to answer, and `handleStripe` marks the order paid on every delivery of the same event. It needs to remember which event ids it has already handled.",
    };
  }
  if (req.toolResultIds.includes(ID.readHook)) {
    return { tools: [{ id: ID.grep, name: "Grep", input: { pattern: "markPaid", path: `${repo}/src` } }] };
  }
  if (req.lastUserText.includes(PROMPTS.apiHistory)) {
    return {
      text: "Reading the webhook handler.",
      tools: [{ id: ID.readHook, name: "Read", input: { file_path: `${repo}/src/webhooks/stripe.ts` } }],
    };
  }
  return null;
}

function docs(req: ApiRequest, root: string): Reply | null {
  const repo = `${root}/acme-docs`;
  if (req.toolResultIds.includes(ID.ask)) return { text: "Publishing v2.1 now." };
  if (req.lastUserText.includes(PROMPTS.docsWork)) {
    return {
      text: "Before I publish:",
      tools: [
        {
          id: ID.ask,
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which SDK release should the guide target?",
                header: "Version",
                multiSelect: false,
                options: [
                  { label: "v2.0", description: "The current stable release" },
                  { label: "v2.1", description: "Adds streaming uploads; out next week" },
                ],
              },
            ],
          },
        },
      ],
    };
  }
  if (req.toolResultIds.includes(ID.writeDoc)) {
    return {
      text: "Drafted `docs/migration-v2.md`: renamed client options, the new error types, and a before-and-after for each breaking change.",
    };
  }
  if (req.lastUserText.includes(PROMPTS.docsHistory)) {
    return {
      text: "Drafting it from the changelog.",
      tools: [
        {
          id: ID.writeDoc,
          name: "Write",
          input: {
            file_path: `${repo}/docs/migration-v2.md`,
            content:
              "# Migrating to v2\n\n## Client options\n\n`apiKey` is now `credentials`.\n\n## Errors\n\nEvery error extends `AcmeError`.\n",
          },
        },
      ],
    };
  }
  return null;
}

function readme(req: ApiRequest): Reply | null {
  if (!req.lastUserText.includes(PROMPTS.readmeHistory)) return null;
  return {
    text: "Fixed three broken links (the old `/guides` paths) and moved installation above configuration, where people look for it first.",
  };
}

function react(req: ApiRequest): Reply | null {
  if (!req.lastUserText.includes(PROMPTS.reactHistory)) return null;
  return {
    text: [
      "Three steps, smallest risk first:",
      "",
      "1. Bump `react` and `react-dom`, then fix the two deprecated lifecycle warnings in the cart.",
      "2. Swap the test renderer for the new `act` import.",
      "3. Run the e2e suite against a preview deploy before merging.",
    ].join("\n"),
  };
}

function assistant(req: ApiRequest, root: string): Reply | null {
  if (!req.system.includes("Cockpit Assistant")) return null;
  if (req.toolResultIds.includes(ID.createJob)) {
    return {
      text: "Done. **Morning issue triage** runs on weekdays at 09:00 on Sonnet 5.5, can read the repo and the issue tracker, and posts its summary to your inbox.",
    };
  }
  if (req.lastUserText.includes(PROMPTS.assistant)) {
    return {
      text: "I'll set that up as a scheduled job that reports to your inbox.",
      tools: [
        {
          id: ID.createJob,
          name: "mcp__cockpit-config__create_job",
          input: {
            name: "Morning issue triage",
            schedules: [{ type: "cron", expression: "0 9 * * 1-5" }],
            prompt:
              "Triage issues created in acme-storefront since the last run: label them, set a priority, and flag anything that needs a human. Finish with a short summary.",
            cwd: `${root}/acme-storefront`,
            model: "claude-sonnet-5-5",
            inboxOutput: true,
            allowedTools: ["Read", "Grep", "mcp__cockpit-config__list_issues", "mcp__cockpit-config__update_issue"],
          },
        },
      ],
    };
  }
  return null;
}

const TITLES: Array<[string, string]> = [
  ["Card-testing bots", "Rate-limit checkout"],
  ["Stripe webhook", "Stripe webhook double payments"],
  ["migration guide", "v2 migration guide"],
  ["React 20", "React 20 upgrade plan"],
  ["triage new issues", "Morning issue triage"],
];

/** The director for a tour whose repos live in `root`. */
export function director(root: string): Director {
  return (req) => {
    if (req.raw.includes('"json_schema"')) {
      const first = req.userTexts.join(" ");
      const title = TITLES.find(([k]) => first.includes(k))?.[1] ?? "Quick question";
      return { text: JSON.stringify({ title }), pace: 1, delayMs: 50 };
    }
    return (
      assistant(req, root) ??
      storefront(req, root) ??
      api(req, root) ??
      docs(req, root) ??
      react(req) ??
      readme(req) ?? { text: "Done.", delayMs: 100 }
    );
  };
}
