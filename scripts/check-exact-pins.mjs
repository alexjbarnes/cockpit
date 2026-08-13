// The tarball ships a prebuilt .next (see package.json "files"), so the Next
// that RUNS the app must be the Next that BUILT it. A caret range lets those
// drift apart at install time: published 0.5.0 declared next ^16.2.4, so once
// 16.3.0 shipped, every fresh install ran a 16.3.0 server against bundles
// compiled by 16.2.11 and threw "renderToPipeableStream is not implemented".
//
// Pinning is not "never upgrade": prepublishOnly rebuilds, so moving a pin and
// rebuilding moves build-time and runtime together. A Dependabot bump is fine.
// A range is not, because only a range can drift after publish.
//
// CI could not catch this by building — CI installs from the lockfile, which is
// already exact. The drift only exists for consumers installing the published
// package, so the check has to be on the declared range itself.
import { readFileSync } from "node:fs";

const PINNED = ["next", "react", "react-dom"];
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const bad = PINNED.filter((name) => !/^\d+\.\d+\.\d+$/.test(pkg.dependencies?.[name] ?? ""));

if (bad.length > 0) {
  console.error("These must be exact versions, not ranges, because the tarball ships a prebuilt .next:");
  for (const name of bad) console.error(`  ${name}: ${pkg.dependencies?.[name] ?? "(missing)"}`);
  console.error("\nBump the version and rebuild instead of widening the range.");
  process.exit(1);
}

console.log(`exact pins ok: ${PINNED.map((n) => `${n}@${pkg.dependencies[n]}`).join(", ")}`);
