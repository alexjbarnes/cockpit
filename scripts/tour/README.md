# The README tour

`record.ts` films the tour in the README into `docs/media/cockpit-tour.mp4`. Re-record it when the UI it shows changes.

GitHub hosts the video, not the repo, so git ignores `docs/media`. To replace it, drag the new file into a comment box on the repo (a new issue's will do, and it needn't be posted). Once it has uploaded, put the `https://github.com/user-attachments/assets/…` link it inserts in place of the one in the README. GitHub plays a link like that inline when it sits on a line of its own, and takes videos up to 10 MB on a free plan.

Nothing on screen is real. The tour starts its own cockpit on a spare port, with a home folder of its own under `/tmp/demo`: three made-up repos, providers on placeholder keys, a month of made-up telemetry for Insights, issues, scheduled jobs with their run history, and an inbox. The real Claude CLI runs every session, against a stand-in API (`mock-api.ts`) whose replies are scripted in `script.ts`.

## Recording

You need a built cockpit (`npm run build`), the `claude` CLI on `PATH`, Playwright's Chromium, and an ffmpeg with libx264. Python's `imageio-ffmpeg` package ships one if your system has none.

```sh
NODE_ENV=development FFMPEG=/path/to/ffmpeg npx tsx scripts/tour/record.ts
```

It takes about five minutes: two to play each session's history through the CLI, then the filming. `TOUR_ROOT` moves the workspace and `TOUR_OUT` the video.

## Working on a scene

Start the world once and leave it running, then film just the scenes you are changing against it:

```sh
NODE_ENV=development npx tsx scripts/tour/explore.ts
TOUR_ATTACH=1 SCENES=insights,issues TOUR_OUT=/tmp/part.mp4 NODE_ENV=development npx tsx scripts/tour/record.ts
```

Scenes run in the order of `SCENES` in `record.ts`, and each expects the state the one before left. A failing scene leaves a screenshot in the workspace.

## How it films

- `capture.ts` takes Chromium's screencast frames with their paint times and encodes them at a steady 30 fps. `Stage.cut()` leaves a wait out of the video, and `Stage.fast()` plays one faster, for Claude working.
- `overlay.ts` draws the pointer (headless Chromium paints none), click ripples, captions and the title cards.
- The phone is a page the tour serves itself, with the session in an iframe behind a lock screen. The notification on it is drawn to match what `session-notify.ts` sends.

Check the scripts with `npx tsc -p scripts/tour/tsconfig.json` and `npx biome check scripts/tour`.
