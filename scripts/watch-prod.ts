import { watch } from "fs";
import { spawn, type Subprocess } from "bun";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "src");
const SERVER_ENTRY = resolve(ROOT, "server.ts");

let server: Subprocess | null = null;
let buildTimeout: ReturnType<typeof setTimeout> | null = null;
let building = false;

async function build(): Promise<boolean> {
  console.log("\x1b[36m[watch] Building...\x1b[0m");
  const start = Date.now();

  const nextBuild = spawn(["npx", "next", "build"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const nextResult = await nextBuild.exited;
  if (nextResult !== 0) {
    const stderr = await new Response(nextBuild.stderr).text();
    console.error("\x1b[31m[watch] next build failed\x1b[0m");
    if (stderr) console.error(stderr);
    return false;
  }

  const tscBuild = spawn(["npx", "tsc", "-p", "tsconfig.server.json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const tscResult = await tscBuild.exited;
  if (tscResult !== 0) {
    const stderr = await new Response(tscBuild.stderr).text();
    console.error("\x1b[31m[watch] tsc failed\x1b[0m");
    if (stderr) console.error(stderr);
    return false;
  }

  console.log(`\x1b[32m[watch] Built in ${((Date.now() - start) / 1000).toFixed(1)}s\x1b[0m`);
  return true;
}

function startServer() {
  if (server) {
    server.kill();
    server = null;
  }

  server = spawn(["bun", "dist/server.js"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  });

  console.log("\x1b[32m[watch] Server started (pid %d)\x1b[0m", server.pid);
}

function scheduleRebuild(path: string) {
  if (building) return;
  if (buildTimeout) clearTimeout(buildTimeout);

  buildTimeout = setTimeout(async () => {
    building = true;
    console.log(`\x1b[33m[watch] Changed: ${path}\x1b[0m`);
    const ok = await build();
    if (ok) startServer();
    building = false;
  }, 500);
}

// Initial build + start
building = true;
const ok = await build();
if (ok) {
  startServer();
} else {
  console.error("\x1b[31m[watch] Initial build failed, waiting for changes...\x1b[0m");
}
building = false;

// Use Bun.FileSystemWatcher for recursive watching
const watcher = watch(SRC, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  if (filename.endsWith(".map") || filename.includes("node_modules")) return;
  scheduleRebuild(`src/${filename}`);
});

// Also watch server.ts
const serverWatcher = watch(ROOT, (_event, filename) => {
  if (filename === "server.ts") {
    scheduleRebuild("server.ts");
  }
});

console.log("\x1b[36m[watch] Watching src/ and server.ts for changes...\x1b[0m");

process.on("SIGINT", () => {
  watcher.close();
  serverWatcher.close();
  if (server) server.kill();
  process.exit(0);
});

// Keep alive
setInterval(() => {}, 60000);
