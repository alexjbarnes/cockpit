// Records the README's tour of cockpit, start to finish, into
// docs/media/cockpit-tour.mp4. Everything on screen is made up: a throwaway
// cockpit with its own config, made-up repos, and a stand-in API scripting
// what Claude says (scripts/tour/script.ts). No account, key or real session
// is involved.
//
// Needs a built cockpit (npm run build), the claude CLI on PATH, Playwright's
// Chromium, and an ffmpeg with libx264 (FFMPEG=/path/to/ffmpeg if it is not
// on PATH). Run from the repo root:
//
//   NODE_ENV=development npx tsx scripts/tour/record.ts
//
// While working on a scene, start the world once with explore.ts and film
// just that scene against it: TOUR_ATTACH=1 SCENES=insights,issues.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { Recorder } from "./capture";
import type { RunningCockpit } from "./cockpit";
import { OVERLAY } from "./overlay";
import { PROMPTS, PUSH_COMMAND, SESSION_NAMES } from "./script";
import { authed, sessionUrl, startTour, type Tour, type TourSession } from "./setup";
import { Stage } from "./stage";

const ROOT = process.env.TOUR_ROOT ?? "/tmp/demo";
const OUT = path.resolve(process.env.TOUR_OUT ?? "docs/media/cockpit-tour.mp4");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const VIEW = { width: 1280, height: 800 };

const log = (line: string) => console.log(`[tour] ${line}`);

const TITLE = `<img src="/icon-512.png" alt=""><h1>Cockpit</h1><p>Claude Code, freed from your terminal</p>`;
const OUTRO = `<img src="/icon-512.png" alt=""><h1>Cockpit</h1><code>npx @alexjbarnes/cockpit</code><small>github.com/alexjbarnes/cockpit</small>`;

const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A phone on a dark stage: the session open behind a lock screen, and the
 *  notification cockpit sends when a session needs approval, worded as
 *  session-notify.ts words it. */
function phoneStage(src: string, title: string, command: string, where: string): string {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:radial-gradient(1100px 760px at 35% 40%,#1d1b29 0%,#0b0b0f 72%);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#fff}
    .wrap{display:flex;align-items:center;justify-content:center;gap:84px;height:100%}
    .device{width:390px;height:844px;transform:scale(.86);transform-origin:50% 30%;transition:transform .7s cubic-bezier(.3,.8,.3,1);margin:-59px -27px;border-radius:58px;padding:13px;background:#16161b;box-shadow:0 0 0 2px #2c2c35,0 40px 120px rgba(0,0,0,.75)}
    .device.zoom{transform:scale(1.16)}
    .screen{position:relative;width:100%;height:100%;border-radius:46px;overflow:hidden;background:#000}
    iframe{width:100%;height:100%;border:0;display:block}
    #lock{position:absolute;inset:0;background:radial-gradient(420px 520px at 30% 20%,#3b2f6b 0%,#171427 55%,#0b0a12 100%);transition:opacity .45s ease}
    #lock.open{opacity:0;pointer-events:none}
    .clock{text-align:center;margin-top:92px}
    .clock .d{font-size:17px;font-weight:500;color:rgba(255,255,255,.85)}
    .clock .t{font-size:84px;font-weight:600;letter-spacing:-.03em;line-height:1.05}
    #note{position:absolute;left:12px;right:12px;top:212px;padding:12px 14px 13px;border-radius:22px;background:rgba(40,38,52,.72);backdrop-filter:blur(22px);box-shadow:0 12px 40px rgba(0,0,0,.45);transform:translateY(-330px) scale(.96);opacity:0;transition:transform .55s cubic-bezier(.2,1.25,.35,1),opacity .3s ease;cursor:pointer}
    #note.show{transform:none;opacity:1}
    #note .h{display:flex;align-items:center;gap:7px;font-size:12px;color:rgba(255,255,255,.7)}
    #note .h img{width:20px;height:20px;border-radius:5px}
    #note .h .w{margin-left:auto}
    #note .ti{font-size:15px;font-weight:650;margin-top:7px}
    #note .b{font-size:14px;line-height:1.35;color:rgba(255,255,255,.88);margin-top:2px}
    #note .c{font-size:13.5px;line-height:1.35;color:rgba(255,255,255,.72);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .copy{max-width:420px}
    .copy h2{font-size:46px;line-height:1.08;margin:0 0 18px;font-weight:750;letter-spacing:-.025em}
    .copy p{font-size:21px;line-height:1.5;color:rgba(255,255,255,.72);margin:0}
  </style></head><body><div class="wrap">
    <div class="device"><div class="screen">
      <iframe name="phone" src="${src}"></iframe>
      <div id="lock">
        <div class="clock"><div class="d">${html(date)}</div><div class="t">${html(time)}</div></div>
        <div id="note">
          <div class="h"><img src="/icon-192.png" alt=""><span>Cockpit</span><span class="w">now</span></div>
          <div class="ti">${html(title)}</div>
          <div class="b">Needs approval</div>
          <div class="c">${html(command)} · ${html(where)}</div>
        </div>
      </div>
    </div></div>
    <div class="copy"><h2>Approve it from your phone</h2><p>Install cockpit as an app and it tells you when a session needs you. Tap the notification and you are straight back in.</p></div>
  </div><script>
    window.stage = {
      notify() {
        document.querySelector(".device").classList.add("zoom");
        setTimeout(() => document.getElementById("note").classList.add("show"), 450);
      },
      open() {
        document.getElementById("lock").classList.add("open");
        document.querySelector(".device").classList.remove("zoom");
      },
    };
    document.getElementById("note").addEventListener("click", () => window.stage.open());
  </script></body></html>`;
}

interface World {
  cockpit: RunningCockpit;
  sessions: Tour["sessions"];
}

interface Scene {
  name: string;
  run(s: Stage, page: Page, world: World): Promise<void>;
}

const footer = (page: Page, title: string) => page.locator(`button[title="${title}"]`).first();
const open = (world: World, session: TourSession) => sessionUrl(world.cockpit, session);

const SCENES: Scene[] = [
  {
    name: "title",
    async run(s, page, world) {
      await s.cut(async () => {
        await page.goto(open(world, world.sessions.storefront));
        await page.getByTestId("message-input").waitFor();
        await page.getByText("Say the word").waitFor();
        await s.card(TITLE);
        await s.wait(900);
        await s.restorePointer();
      });
      await s.wait(2000);
      await s.hideCard();
      await s.wait(600);
    },
  },
  {
    name: "sessions",
    async run(s, page) {
      await s.caption("Every session, one window", "Working, waiting on you, or done: the sidebar shows which at a glance", "top");
      await s.glideTo(page.getByText("Stripe webhook double payments"), { dx: -40, ms: 550 });
      await s.glideTo(page.getByText("v2 migration guide"), { dx: -40, ms: 400 });
      await s.wait(700);
      await s.caption("The real Claude Code, in your browser", "Not a reimplementation: cockpit drives the CLI itself", "top");
      await s.click(page.getByTestId("message-input"), { settle: 120 });
      await s.type(PROMPTS.storefrontWork, 16);
      await s.click(page.getByTestId("btn-send"), { settle: 150 });
      await s.glide(860, 470, 600);
      await s.fast(3, () => page.getByText("All 12 tests pass.").waitFor({ timeout: 90_000 }));
      await s.wait(700);
      await s.caption("Every change as a diff", "", "top");
      const edit = page.locator("button", { hasText: "Edit" }).filter({ hasText: "checkout.ts" }).first();
      await s.click(edit, { settle: 300 });
      await s.glide(1000, 520, 500);
      await s.wait(1300);
    },
  },
  {
    name: "split",
    async run(s, page) {
      await s.caption("Files, a terminal and the chat, side by side", "Open anything in a tab, split the view, and edit in place");
      await s.click(page.getByText("Session Files", { exact: true }), { settle: 300 });
      await s.click(page.getByText("README.md", { exact: true }).first(), { settle: 400 });
      await s.click(page.locator('button[title="Split view"]'), { settle: 500 });
      await s.click(page.getByTestId("file-edit"), { settle: 300 });
      const editor = page.locator(".cm-content").last();
      await s.click(editor, { dy: 260, settle: 100 });
      await page.keyboard.press("Control+End");
      await s.type("\n## Rate limits\n\nCheckout allows 10 attempts a minute per customer.\n", 14);
      await s.click(page.getByTestId("file-save"), { settle: 400 });
      await s.click(page.getByRole("button", { name: "Show preview" }), { settle: 300 });
      await s.glide(1100, 700, 300);
      await s.wait(900);
      await s.click(page.locator('button[title^="New terminal"]'), { settle: 300 });
      const terminal = page.locator(".xterm").first();
      await s.cut(async () => {
        await terminal.waitFor({ timeout: 30_000 });
        await s.wait(1_500);
      });
      await s.click(terminal, { settle: 150 });
      await s.type("npm test\n", 30);
      await s.wait(1500);
      await s.click(page.getByRole("button", { name: "Chat" }).first(), { settle: 300 });
      await s.click(page.locator('button[title="Close split view"]'), { settle: 400 });
    },
  },
  {
    name: "switch",
    async run(s, page) {
      await s.caption("Switch models mid-session", "Claude, DeepSeek, OpenRouter, OpenCode and more, through the same agent loop", "top");
      await s.click(page.getByTestId("model-pill"), { settle: 300 });
      await s.click(page.getByTestId("model-view-model"), { settle: 300 });
      await s.click(page.getByTestId("model-provider"), { settle: 500 });
      await s.click(page.getByTestId("model-provider-deepseek"), { settle: 300 });
      await s.click(page.getByText("deepseek-v4-pro", { exact: true }), { settle: 200 });
      await s.click(page.getByRole("button", { name: "Done" }), { settle: 150 });
      await s.cut(async () => {
        await page
          .getByTestId("model-pill")
          .filter({ hasText: /deepseek/i })
          .waitFor({ timeout: 30_000 });
        await s.wait(4_000);
      });
      await s.glideTo(page.getByTestId("model-pill"), { ms: 450 });
      await s.wait(500);
      await s.click(page.getByTestId("message-input"), { settle: 120 });
      await s.type(PROMPTS.storefrontSwitch, 20);
      await s.click(page.getByTestId("btn-send"), { settle: 150 });
      await s.glide(860, 430, 500);
      await s.fast(3, () => page.getByText("Closes").waitFor({ timeout: 60_000 }));
      await s.wait(1200);
    },
  },
  {
    name: "providers",
    async run(s, page) {
      await s.caption("Every provider under one roof", "Connect a key once, then pick a model per session or per job");
      await s.click(footer(page, "Settings"), { settle: 400 });
      await s.click(page.getByRole("button", { name: "Model Providers" }), { settle: 500 });
      await s.wait(400);
      await s.click(page.getByRole("button", { name: /Manage models/ }).first(), { settle: 400 });
      await s.click(page.getByRole("button", { name: "Free", exact: true }), { settle: 400 });
      await s.wait(700);
    },
  },
  {
    name: "insights",
    async run(s, page) {
      await s.caption("Insights", "What every session and job costs, how fast each model is, and where the time goes");
      await s.click(page.getByTestId("sidebar-insights"), { settle: 150 });
      await s.cut(async () => {
        await page.getByTestId("tile-spend").waitFor({ timeout: 30_000 });
        await s.wait(800);
      });
      await s.click(page.getByRole("button", { name: "30d", exact: true }), { settle: 150 });
      await s.cut(() => s.wait(1_000));
      await s.wait(1000);
      await s.click(page.getByTestId("insights-tab-spend"), { settle: 150 });
      await s.cut(async () => {
        await page.getByTestId("chart-spend").waitFor({ timeout: 30_000 });
        await s.wait(800);
      });
      await s.click(page.getByRole("button", { name: "Provider", exact: true }), { settle: 300 });
      const box = await s.box(page.getByTestId("chart-spend").locator("svg"));
      await s.glide(box.x + box.width * 0.72, box.y + box.height * 0.6, 600);
      await s.glide(box.x + box.width * 0.88, box.y + box.height * 0.6, 700);
      await s.wait(500);
      await s.click(page.getByTestId("insights-tab-speed"), { settle: 150 });
      await s.cut(async () => {
        await page.getByTestId("panel-models").waitFor({ timeout: 30_000 });
        await s.wait(600);
      });
      await s.wait(1200);
    },
  },
  {
    name: "issues",
    async run(s, page) {
      await s.caption("A built-in issue tracker", "Jobs refine and plan issues; sessions pick them up and move them along");
      await s.click(footer(page, "Issues"), { settle: 400 });
      await s.click(page.getByText("Board", { exact: true }), { settle: 500 });
      await s.glide(820, 400, 400);
      await s.scroll(0, 800, 900);
      await s.click(page.getByText("Rate-limit the checkout endpoint"), { settle: 500 });
      await s.glide(760, 560, 400);
      await s.wait(1200);
    },
  },
  {
    name: "assistant",
    async run(s, page) {
      await s.hideCaption();
      await s.click(page.getByTestId("assistant-button"), { settle: 200 });
      // cockpit's dialogs are a full-screen overlay holding the panel.
      const dialog = page.locator("div.fixed.inset-0.z-50").last();
      await s.cut(async () => {
        await dialog.getByTestId("message-input").waitFor({ timeout: 60_000 });
        await s.wait(4_000);
      });
      await s.caption("The Cockpit Assistant", "Set cockpit up by asking: jobs, providers, MCP servers, settings", "top");
      await s.click(dialog.getByTestId("message-input"), { settle: 120 });
      await s.type(PROMPTS.assistant, 15);
      await s.click(dialog.getByTestId("btn-send"), { settle: 200 });
      await s.glide(640, 420, 400);
      const approve = dialog.getByRole("button", { name: "Approve" });
      await s.fast(3, () => approve.waitFor({ timeout: 60_000 }));
      await s.caption("Changes wait for your approval", "", "top");
      await s.glideTo(approve, { dy: -120, ms: 500 });
      await s.wait(1200);
      await s.click(approve, { settle: 200 });
      await s.fast(3, () => page.getByText("posts its summary to your inbox").waitFor({ timeout: 60_000 }));
      await s.wait(1300);
      await page.keyboard.press("Escape");
      await s.wait(250);
    },
  },
  {
    name: "jobs",
    async run(s, page) {
      await s.caption("Scheduled jobs", "Unattended runs on a schedule, each with its own model, tools and time budget");
      await s.click(footer(page, "Scheduled Jobs"), { settle: 500 });
      await s.glide(780, 450, 400);
      await s.scroll(520, 900);
      await s.click(page.getByText("Morning PR triage", { exact: true }).first(), { settle: 500 });
      await s.glide(760, 600, 400);
      await s.wait(900);
    },
  },
  {
    name: "inbox",
    async run(s, page) {
      await s.caption("Results land in your inbox", "And on your phone, through Telegram or ntfy");
      await s.click(footer(page, "Inbox"), { settle: 150 });
      await s.cut(async () => {
        await page.getByText("Morning PR triage", { exact: true }).first().waitFor({ timeout: 30_000 });
        await s.wait(400);
      });
      await s.wait(400);
      await s.click(page.getByText("Morning PR triage", { exact: true }).first(), { settle: 500 });
      await s.wait(1300);
    },
  },
  {
    name: "phone",
    async run(s, page) {
      // Back at the desk: one more ask, and it needs approval.
      await s.caption("Step away from your desk", "When a session needs you, cockpit tells your phone", "top");
      await s.click(page.getByText(SESSION_NAMES.storefront).first(), { settle: 300 });
      await s.cut(async () => {
        await page.getByTestId("message-input").waitFor({ timeout: 30_000 });
        await s.wait(1_500);
      });
      await s.click(page.getByTestId("message-input"), { settle: 120 });
      await s.type(PROMPTS.storefrontPush, 20);
      await s.click(page.getByTestId("btn-send"), { settle: 150 });
      await s.glide(860, 560, 500);
      await s.fast(3, () => page.getByTestId("permission-prompt").waitFor({ timeout: 60_000 }));
      await s.wait(1400);
      await s.hideCaption();
      await s.dip(async () => {
        await page.goto(`${page.url().split("/sessions/")[0]}/__tour/phone`);
        await page.frameLocator("iframe[name=phone]").getByTestId("permission-prompt").waitFor({ timeout: 60_000 });
        await s.wait(1_000);
        await s.touch(true);
        await s.hidePointer(true);
      });
      await s.wait(700);
      await page.evaluate(() => (window as unknown as { stage: { notify(): void } }).stage.notify());
      await s.wait(2300);
      await s.hidePointer(false);
      await s.tap(page.locator("#note"));
      await s.wait(1100);
      const phone = page.frameLocator("iframe[name=phone]");
      await s.tap(phone.getByTestId("btn-allow"));
      await s.fast(3, () => phone.getByText("ready for a pull request").waitFor({ timeout: 60_000 }));
      await s.wait(1200);
      await s.tap(phone.locator('button[title="Toggle sidebar (Ctrl+B)"]'));
      await s.wait(1500);
      await s.hidePointer(true);
    },
  },
  {
    name: "outro",
    async run(s) {
      await s.hidePointer(true);
      await s.hideCaption();
      await s.card(OUTRO);
      await s.wait(3400);
    },
  },
];

async function film(world: World, browser: Tour["browser"], only: string[] | null): Promise<Stage> {
  const context = await authed(browser, world.cockpit, { viewport: VIEW, deviceScaleFactor: 2 });
  await context.addInitScript(OVERLAY);
  const storefront = world.sessions.storefront;
  await context.route(`${world.cockpit.url}/__tour/phone`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: phoneStage(open(world, storefront), SESSION_NAMES.storefront, PUSH_COMMAND, path.basename(storefront.cwd)),
    }),
  );
  const page = await context.newPage();
  const rec = new Recorder(page, path.join(ROOT, "frames"), { width: VIEW.width * 2, height: VIEW.height * 2 });
  const s = new Stage(page, rec);
  const scenes = only ? SCENES.filter((sc) => only.includes(sc.name)) : SCENES;
  if (only && scenes[0]?.name !== "title") {
    // Filming part of the tour: start where the first chosen scene expects.
    await page.goto(open(world, storefront));
    await page.getByTestId("message-input").waitFor();
    await s.restorePointer();
  }
  await rec.start();
  for (const scene of scenes) {
    const from = rec.elapsed;
    log(`scene: ${scene.name}`);
    try {
      await scene.run(s, page, world);
      log(`  ${scene.name}: ${(rec.elapsed - from).toFixed(1)} s`);
    } catch (err) {
      const shot = path.join(ROOT, `failed-${scene.name}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      log(`scene ${scene.name} failed; screenshot at ${shot}`);
      throw err;
    }
  }
  await rec.stop();
  return s;
}

async function main(): Promise<void> {
  mkdirSync(path.dirname(OUT), { recursive: true });
  const only = process.env.SCENES ? process.env.SCENES.split(",").map((n) => n.trim()) : null;
  let world: World;
  let browser: Tour["browser"];
  let stop: () => Promise<void>;
  if (process.env.TOUR_ATTACH) {
    const saved = JSON.parse(readFileSync(path.join(ROOT, "tour.json"), "utf8")) as {
      url: string;
      token: string;
      sessions: Tour["sessions"];
    };
    const port = Number(new URL(saved.url).port);
    world = { cockpit: { url: saved.url, port, token: saved.token, stop: async () => {} }, sessions: saved.sessions };
    browser = await chromium.launch();
    stop = () => browser.close();
  } else {
    const tour = await startTour(ROOT, log);
    world = tour;
    browser = tour.browser;
    stop = () => tour.stop();
  }
  try {
    const stage = await film(world, browser, only);
    log(`filmed ${stage.rec.elapsed.toFixed(1)} s; encoding`);
    stage.rec.encode(FFMPEG, OUT, { width: 1920, height: 1200 });
    log(`wrote ${OUT}`);
  } finally {
    await stop();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
