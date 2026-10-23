// Brings the tour's world up and leaves it running, to look around in a
// browser while writing scenes. Prints the URL and the session ids.
//
//   npx tsx scripts/tour/explore.ts [root]

import { writeFileSync } from "node:fs";
import path from "node:path";
import { startTour } from "./setup";

async function main(): Promise<void> {
  const tour = await startTour(process.argv[2] ?? "/tmp/demo", (line) => console.log(line));
  // What record.ts needs to film against this world (TOUR_ATTACH=1).
  writeFileSync(
    path.join(tour.dirs.root, "tour.json"),
    JSON.stringify({ url: tour.cockpit.url, token: tour.cockpit.token, sessions: tour.sessions }),
  );
  console.log(`ready ${tour.cockpit.url}`);
  console.log(JSON.stringify(tour.sessions));
  const stop = async () => {
    await tour.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
