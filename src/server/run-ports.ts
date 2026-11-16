// A port of its own for each unattended run. A skill that starts a server (a
// test instance for a person to look at, a dev server for a browser check)
// needs a port, and two runs each scanning for a free one can both settle on
// the same number between looking and binding. Cockpit hands each run a
// different one and keeps it out of circulation until the run is over.

/** A range nothing common listens in, wide enough that it is never exhausted. */
const FIRST_PORT = 42_000;
const LAST_PORT = 42_999;

const held = new Map<number, string>();
let cursor = FIRST_PORT;

/** A port no other run holds, kept for `holder` until released. */
export function reserveRunPort(holder: string): number {
  for (let tried = 0; tried <= LAST_PORT - FIRST_PORT; tried++) {
    const port = cursor;
    cursor = cursor >= LAST_PORT ? FIRST_PORT : cursor + 1;
    if (!held.has(port)) {
      held.set(port, holder);
      return port;
    }
  }
  throw new Error("No port is free for this run");
}

/** Give back every port `holder` holds. */
export function releaseRunPorts(holder: string): void {
  for (const [port, owner] of held) if (owner === holder) held.delete(port);
}

/** How many ports are out, for tests. */
export function heldRunPorts(): number {
  return held.size;
}
