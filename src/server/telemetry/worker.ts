// The telemetry worker thread: owns the SQLite database so the server's main
// thread never parses an OTLP batch or waits on a write. Its logic is in
// worker-core.ts; this file only connects it to the thread.

import { parentPort, workerData } from "node:worker_threads";
import type { WorkerInit, WorkerRequest, WorkerResponse } from "./protocol";
import { createWorkerCore, openStore } from "./worker-core";

const port = parentPort;
if (port) {
  const init = workerData as WorkerInit;
  const post = (r: WorkerResponse) => port.postMessage(r);
  const opened = openStore(init);
  if ("reason" in opened) {
    post({ type: "ready", available: false, reason: opened.reason });
  } else {
    const core = createWorkerCore(opened.db, post, { pruneEveryMs: init.pruneEveryMs });
    port.on("message", (msg: WorkerRequest) => core.handle(msg));
    core.startPruning();
    post({ type: "ready", available: true });
  }
}
