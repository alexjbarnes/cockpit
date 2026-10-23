// The tour's world, written before cockpit starts: a config folder with a
// password, providers on placeholder keys and their model lists, three small
// made-up repos, and a CLI config that trusts them. Nothing here is real.

import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TourDirs } from "./cockpit";

const DAY = 24 * 60 * 60 * 1000;

/** The tour's home folder is its root, so paths on screen read ~/code/... and
 *  /tmp/demo/code/... rather than anything of the machine's. */
export function tourDirs(root: string): TourDirs {
  return { root, home: root, config: path.join(root, ".cockpit"), claude: path.join(root, ".claude") };
}

const MARKER = ".cockpit-tour";

export const REPOS = {
  storefront: "acme-storefront",
  api: "acme-api",
  docs: "acme-docs",
};

export function repoPath(dirs: TourDirs, name: string): string {
  return path.join(dirs.home, "code", name);
}

function json(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// ── Providers ───────────────────────────────────────────────────────────────

const model = (
  modelId: string,
  displayName: string,
  extra: { in?: number; out?: number; cache?: number; free?: boolean; ctx?: number; effort?: boolean } = {},
) => ({
  modelId,
  displayName,
  effortLevels: extra.effort === false ? [] : ["low", "medium", "high", "max"],
  contextSizes: [],
  contextLength: extra.ctx ?? 200_000,
  ...(extra.in !== undefined
    ? { pricing: { inPerM: extra.in, outPerM: extra.out ?? 0, ...(extra.cache ? { cacheReadPerM: extra.cache } : {}) } }
    : {}),
  ...(extra.free ? { free: true } : {}),
  supportsTools: true,
  supportsReasoning: extra.effort !== false,
});

export const DEEPSEEK_PRO = "deepseek-v4-pro";

function providers(now: number) {
  const builtin = (id: string, name: string, keyVar: string | null, models: unknown[], enabled: string[] = []) => ({
    id,
    name,
    isBuiltin: true,
    envVars: keyVar ? { [keyVar]: "demo-key-not-real" } : {},
    models,
    enabledModels: enabled,
    syncedAt: now,
  });
  return [
    {
      id: "openrouter",
      name: "OpenRouter",
      isBuiltin: true,
      envVars: { ANTHROPIC_AUTH_TOKEN: "demo-key-not-real" },
      models: [],
      enabledModels: ["thinkingmachines/inkling:free", "z-ai/glm-5.3", "openai/gpt-6.1-sol", "google/gemma-4-31b-it:free"],
    },
    builtin(
      "deepseek",
      "DeepSeek",
      "DEEPSEEK_API_KEY",
      [
        model("deepseek-flash", "DeepSeek Flash", { in: 0.15, out: 0.6, cache: 0.003, ctx: 1_000_000 }),
        model(DEEPSEEK_PRO, "DeepSeek V4 Pro", { in: 0.66, out: 1.98, cache: 0.022, ctx: 1_000_000 }),
      ],
      ["deepseek-flash", DEEPSEEK_PRO],
    ),
    builtin(
      "zen-go",
      "OpenCode Go",
      "OPENCODE_GO_API_KEY",
      [
        model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", { in: 0.15, out: 0.6, cache: 0.003, ctx: 1_000_000 }),
        model("glm-5.3", "GLM-5.3", { in: 1.4, out: 4.4, cache: 0.26 }),
        model("grok-4.7", "Grok 4.7", { in: 2, out: 6, cache: 0.5, ctx: 500_000 }),
      ],
      ["deepseek-v4.1-flash", "glm-5.3", "grok-4.7"],
    ),
    builtin("zen", "OpenCode Zen", null, [
      model("big-pickle", "Big Pickle", { in: 0, out: 0, free: true }),
      model("mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free", { in: 0, out: 0, free: true }),
      model("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", { in: 0, out: 0, free: true }),
    ]),
    builtin("groq", "Groq", null, [
      model("openai/gpt-oss-120b", "GPT OSS 120B", { in: 0.15, out: 0.6, cache: 0.075, effort: false }),
      model("openai/gpt-oss-20b", "GPT OSS 20B", { in: 0.075, out: 0.3, cache: 0.0375, effort: false }),
    ]),
    builtin("gemini", "Google AI Studio (Gemini)", null, [
      model("gemini-3.6-flash", "Gemini 3.6 Flash", { in: 0.75, out: 3.75, cache: 0.075, ctx: 1_048_576 }),
      model("gemma-4-31b-it", "Gemma 4 31B IT", { in: 0, out: 0, free: true }),
    ]),
    builtin("nvidia", "NVIDIA NIM", null, [model("deepseek-ai/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", { in: 0, out: 0, free: true })]),
    builtin("commandcode", "CommandCode", null, []),
  ];
}

/** A slice of OpenRouter's public catalogue, as its /models lists it. */
function openRouterCatalog(now: number) {
  const m = (id: string, name: string, inPerM: number, outPerM: number, cache: number, ctx: number) => ({
    ...model(id, name, { in: inPerM, out: outPerM, ...(cache ? { cache } : {}), ctx, free: inPerM === 0 && outPerM === 0 }),
    supportsImageInput: false,
  });
  return {
    syncedAt: now,
    consecutiveFailures: 0,
    delisted: [],
    models: [
      m("anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 4, 20, 0.2, 1_000_000),
      m("anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5", 2, 10, 0.1, 1_000_000),
      m("openai/gpt-6.1-sol", "OpenAI: GPT-6.1 Sol", 2, 10, 0.1, 1_050_000),
      m("openai/gpt-6-luna", "OpenAI: GPT-6 Luna", 0.1, 0.5, 0.01, 1_050_000),
      m("google/gemini-3.8-flash", "Google: Gemini 3.8 Flash", 0.825, 4.125, 0.0825, 1_048_576),
      m("deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash", 0.165, 0.66, 0.006, 1_048_576),
      m("z-ai/glm-5.3", "Z.ai: GLM 5.3", 0.079, 1.4, 0.078, 1_048_576),
      m("qwen/qwen3.8-max-0902", "Qwen: Qwen3.8 Max (0902)", 2, 6, 0.25, 1_000_000),
      m("x-ai/grok-4.7", "SpaceXAI: Grok 4.7", 2, 6, 0.5, 500_000),
      m("mistralai/mistral-large-4-0", "Mistral: Mistral Large 4", 1.36, 4.18, 0.14, 1_048_576),
      m("minimax/minimax-m3.1-flash", "MiniMax: MiniMax M3.1 Flash", 0.15, 0.6, 0.015, 1_048_576),
      m("nvidia/nemotron-3-ultra-550b-a55b:free", "NVIDIA: Nemotron 3 Ultra (free)", 0, 0, 0, 1_000_000),
      m("google/gemma-4-31b-it:free", "Google: Gemma 4 31B (free)", 0, 0, 0, 262_144),
      m("thinkingmachines/inkling:free", "Thinking Machines: Inkling (free)", 0, 0, 0, 1_048_576),
      m("poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1 (free)", 0, 0, 0, 262_144),
      m("cohere/north-mini-code:free", "Cohere: North Mini Code (free)", 0, 0, 0, 256_000),
    ],
  };
}

// ── Repos ───────────────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Sam Rivera",
  GIT_AUTHOR_EMAIL: "sam@acme.example",
  GIT_COMMITTER_NAME: "Sam Rivera",
  GIT_COMMITTER_EMAIL: "sam@acme.example",
};

function git(cwd: string, home: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
}

export const CHECKOUT_ROUTE = `import { Router } from "express";
import { requireCustomer } from "../lib/auth";
import { createOrder } from "../services/orders";
import { chargeCard } from "../services/payments";

export const checkout = Router();

checkout.post("/checkout", requireCustomer, async (req, res) => {
  const { cartId, paymentMethodId } = req.body;
  const order = await createOrder(req.customer.id, cartId);
  const charge = await chargeCard(order, paymentMethodId);
  if (!charge.ok) {
    return res.status(402).json({ error: charge.reason });
  }
  res.status(201).json({ orderId: order.id, total: order.total });
});
`;

const TEST_RUNNER = `// Runs the suite and reports in the usual shape.
const suites = [
  ["tests/cart.test.ts", ["adds an item", "merges duplicate items", "drops an item at zero quantity", "prices a bundle"]],
  ["tests/checkout.test.ts", ["creates an order", "returns 402 when the card is declined", "rejects an empty cart", "rate limits a customer after 10 requests a minute", "lets another customer through"]],
  ["tests/orders.test.ts", ["numbers orders per day", "refunds a cancelled order", "keeps totals in pence"]],
];
let n = 0;
console.log("\\n RUN  v4.2.1 ~/code/acme-storefront\\n");
for (const [file, cases] of suites) {
  console.log(\` ✓ \${file} (\${cases.length} tests)\`);
  for (const c of cases) console.log(\`   ✓ \${c}\`);
  n += cases.length;
}
console.log(\`\\n Test Files  \${suites.length} passed (\${suites.length})\`);
console.log(\`      Tests  \${n} passed (\${n})\`);
console.log("   Duration  1.84s\\n");
`;

function storefront(dir: string): void {
  json(path.join(dir, "package.json"), {
    name: "acme-storefront",
    private: true,
    version: "2.4.0",
    scripts: { dev: "next dev", build: "next build", test: "node scripts/test.mjs" },
  });
  write(path.join(dir, "scripts", "test.mjs"), TEST_RUNNER);
  write(path.join(dir, "src", "routes", "checkout.ts"), CHECKOUT_ROUTE);
  write(
    path.join(dir, "src", "routes", "cart.ts"),
    `import { Router } from "express";\nimport { requireCustomer } from "../lib/auth";\nimport { getCart, addItem } from "../services/cart";\n\nexport const cart = Router();\n\ncart.get("/cart", requireCustomer, async (req, res) => {\n  res.json(await getCart(req.customer.id));\n});\n\ncart.post("/cart/items", requireCustomer, async (req, res) => {\n  res.status(201).json(await addItem(req.customer.id, req.body));\n});\n`,
  );
  write(
    path.join(dir, "src", "lib", "auth.ts"),
    `import type { NextFunction, Request, Response } from "express";\nimport { verifySession } from "./session";\n\nexport async function requireCustomer(req: Request, res: Response, next: NextFunction) {\n  const customer = await verifySession(req.cookies.session);\n  if (!customer) return res.status(401).json({ error: "Sign in to continue" });\n  req.customer = customer;\n  next();\n}\n`,
  );
  write(
    path.join(dir, "tests", "checkout.test.ts"),
    `import { describe, expect, it } from "vitest";\nimport { request } from "./helpers";\n\ndescribe("POST /checkout", () => {\n  it("creates an order", async () => {\n    const res = await request.post("/checkout").send({ cartId: "c_1", paymentMethodId: "pm_ok" });\n    expect(res.status).toBe(201);\n  });\n\n  it("returns 402 when the card is declined", async () => {\n    const res = await request.post("/checkout").send({ cartId: "c_1", paymentMethodId: "pm_declined" });\n    expect(res.status).toBe(402);\n  });\n});\n`,
  );
  write(
    path.join(dir, "README.md"),
    [
      "# Acme Storefront",
      "",
      "The Acme shop: catalogue, cart and checkout, on Next.js and Express.",
      "",
      "## Getting started",
      "",
      "```sh",
      "npm install",
      "npm run dev",
      "```",
      "",
      "The shop runs on http://localhost:3000 against the staging API.",
      "",
      "## Scripts",
      "",
      "| Script | What it does |",
      "| --- | --- |",
      "| `npm run dev` | Starts the shop with hot reload |",
      "| `npm test` | Runs the unit and route tests |",
      "| `npm run build` | Builds for production |",
      "",
      "## Checkout",
      "",
      "Checkout creates the order, then charges the card. A declined card answers **402** and leaves the order unpaid.",
      "",
    ].join("\n"),
  );
}

function api(dir: string): void {
  json(path.join(dir, "package.json"), { name: "acme-api", private: true, version: "1.9.3", scripts: { test: "node scripts/test.mjs" } });
  write(path.join(dir, "scripts", "test.mjs"), TEST_RUNNER.replace("acme-storefront", "acme-api"));
  write(
    path.join(dir, "src", "webhooks", "stripe.ts"),
    `import { verifySignature } from "../lib/signing";\nimport { markPaid } from "../services/orders";\n\nexport async function handleStripe(body: string, signature: string) {\n  const event = verifySignature(body, signature);\n  if (event.type === "payment_intent.succeeded") {\n    await markPaid(event.data.object.metadata.orderId);\n  }\n}\n`,
  );
  write(path.join(dir, "README.md"), "# Acme API\n\nOrders, payments and webhooks.\n");
}

function docs(dir: string): void {
  json(path.join(dir, "package.json"), { name: "acme-docs", private: true, version: "0.1.0" });
  write(path.join(dir, "docs", "getting-started.md"), "# Getting started\n\nInstall the SDK and create a client.\n");
  write(path.join(dir, "README.md"), "# Acme Docs\n\nThe public developer docs.\n");
}

/** What sessions may do without asking: edit files and run the tests. Anything
 *  else, a push say, waits for approval. */
const PROJECT_SETTINGS = { permissions: { allow: ["Edit", "Write", "Bash(npm test)", "Bash(npm test:*)"] } };

function initRepo(dir: string, home: string, build: (dir: string) => void): void {
  build(dir);
  json(path.join(dir, ".claude", "settings.json"), PROJECT_SETTINGS);
  git(dir, home, "init", "-q", "-b", "main");
  git(dir, home, "config", "user.name", GIT_ENV.GIT_AUTHOR_NAME);
  git(dir, home, "config", "user.email", GIT_ENV.GIT_AUTHOR_EMAIL);
  git(dir, home, "add", ".");
  git(dir, home, "commit", "-q", "-m", "Initial commit");
  // A remote on disk, so a push goes somewhere real.
  const remote = path.join(home, "remotes", `${path.basename(dir)}.git`);
  mkdirSync(remote, { recursive: true });
  git(remote, home, "init", "-q", "--bare");
  git(dir, home, "remote", "add", "origin", remote);
  git(dir, home, "push", "-q", "-u", "origin", "main");
}

// ── Everything ──────────────────────────────────────────────────────────────

export const TOUR_PASSWORD = "cockpit-tour";

export function seedWorld(dirs: TourDirs, now = Date.now()): void {
  // Only ever clear a folder this tour made.
  if (existsSync(dirs.root) && readdirSync(dirs.root).length && !existsSync(path.join(dirs.root, MARKER))) {
    throw new Error(`${dirs.root} exists and is not a tour folder; pick another TOUR_ROOT`);
  }
  rmSync(dirs.root, { recursive: true, force: true });
  mkdirSync(dirs.config, { recursive: true });
  writeFileSync(path.join(dirs.root, MARKER), "");
  mkdirSync(dirs.claude, { recursive: true });

  const salt = randomBytes(32);
  json(path.join(dirs.config, "password.json"), {
    hash: scryptSync(TOUR_PASSWORD, salt, 64).toString("hex"),
    salt: salt.toString("hex"),
  });
  json(path.join(dirs.config, "providers.json"), providers(now));
  json(path.join(dirs.config, "provider-catalog.json"), openRouterCatalog(now));
  json(path.join(dirs.config, "defaults.json"), {
    modelSlots: { main: "claude-opus-5-5", mainContext: "1m" },
    thinkingLevel: "high",
    // Cockpit asks before anything the projects' own rules do not allow.
    permissionMode: "manual",
    telemetryEnabled: true,
    issuesEnabled: true,
    // Footer pages open full size, which reads better on video than the modal.
    modalPagesEnabled: false,
  });

  const repos = Object.values(REPOS).map((name) => repoPath(dirs, name));
  initRepo(repos[0], dirs.home, storefront);
  initRepo(repos[1], dirs.home, api);
  initRepo(repos[2], dirs.home, docs);

  // The terminal tab's shell, which is the login shell (fish or bash): a plain
  // prompt with no machine name, and no greeting.
  write(
    path.join(dirs.home, ".config", "fish", "config.fish"),
    [
      'set -g fish_greeting ""',
      "function fish_prompt",
      "    set_color 87d787; echo -n 'sam@acme '",
      "    set_color 87afff; echo -n (string replace $HOME '~' $PWD)",
      "    set_color normal; echo -n (fish_git_prompt) ' $ '",
      "end",
      "function fish_right_prompt; end",
      "",
    ].join("\n"),
  );
  write(
    path.join(dirs.home, ".bash_profile"),
    "PS1='\\[\\e[38;5;114m\\]sam@acme\\[\\e[0m\\] \\[\\e[38;5;111m\\]\\w\\[\\e[0m\\] $ '\nexport PS1\n",
  );

  json(path.join(dirs.claude, ".claude.json"), {
    theme: "dark",
    hasCompletedOnboarding: true,
    // The repos, and cockpit's own folder, where the Cockpit Assistant runs.
    projects: Object.fromEntries([...repos, dirs.config].map((r) => [r, { hasTrustDialogAccepted: true }])),
  });
  void DAY;
}
