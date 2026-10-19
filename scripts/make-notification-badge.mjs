// Renders public/notification-badge.png, the small icon Android draws in the
// status bar for a push notification.
//
// Two things about that image are forced by Android: it uses only the alpha
// channel and paints it white, so a full-colour icon arrives as a white square;
// and it draws it about 24px tall, so anything but a silhouette turns to mush.
//
// So the badge is the app icon's own outline, traced from public/icon-192.png
// rather than drawn by hand — the mark is a canopy shape that flares out and
// then tapers to a rounded point, which is not something to eyeball — and the
// detail inside the frame (the four quadrants) is left out, since none of it
// survives the size.
//
// Run with: node scripts/make-notification-badge.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "public", "icon-192.png");
const out = path.join(here, "..", "public", "notification-badge.png");

const SIZE = 96;
const MARGIN = 8;

/** Trace the icon: for each row, the frame's outer edges and its inner ones.
 *  The mark is an outlined shape, so a row crosses it twice — the first dark
 *  run is the left of the frame and the last is the right; whatever sits
 *  between them is the detail inside, which this ignores. */
function trace(path, width, height, channels, data) {
  const alpha = (i) => data[i + 3] / 255;
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const dark = (x, y) => {
    const i = (y * width + x) * channels;
    return alpha(i) > 0.5 && lum(i) < 128;
  };

  const rows = [];
  for (let y = 0; y < height; y++) {
    const runs = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const isDark = x < width && dark(x, y);
      if (isDark && start < 0) start = x;
      else if (!isDark && start >= 0) {
        runs.push([start, x - 1]);
        start = -1;
      }
    }
    if (runs.length === 0) continue;
    const first = runs[0];
    const last = runs[runs.length - 1];
    // The outer edge is the extremes of the row, which holds for every row
    // including the cap rows at the top and bottom — there the frame is one
    // solid horizontal run. The hole between the left and right of the frame
    // only exists where a row crosses it twice, so the cap rows contribute
    // nothing to the inner edge and the hole closes flat across them.
    const inner = runs.length >= 2 ? [first[1], last[0]] : null;
    rows.push({ y, outer: [first[0], last[1]], inner });
  }
  if (rows.length === 0) throw new Error(`no outline found in ${path}`);
  return rows;
}

function polygon(points) {
  return `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ")} Z`;
}

const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const rows = trace(source, info.width, info.height, info.channels, data);

const minX = Math.min(...rows.map((r) => r.outer[0]));
const maxX = Math.max(...rows.map((r) => r.outer[1]));
const minY = rows[0].y;
const maxY = rows[rows.length - 1].y;

// Fit the mark into the box, centred, keeping its proportions.
const scale = Math.min((SIZE - 2 * MARGIN) / (maxX - minX + 1), (SIZE - 2 * MARGIN) / (maxY - minY + 1));
const offsetX = (SIZE - (maxX - minX + 1) * scale) / 2;
const offsetY = (SIZE - (maxY - minY + 1) * scale) / 2;
const map = ([x, y]) => [offsetX + (x - minX) * scale, offsetY + (y - minY) * scale];

// Outer edge down the left and back up the right, then the inner edge the other
// way round; evenodd leaves the middle hollow without either winding mattering.
const outer = [...rows.map((r) => map([r.outer[0], r.y])), ...[...rows].reverse().map((r) => map([r.outer[1], r.y]))];
const holed = rows.filter((r) => r.inner);
const inner = [...holed.map((r) => map([r.inner[1], r.y])), ...[...holed].reverse().map((r) => map([r.inner[0], r.y]))];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <path d="${polygon(outer)} ${polygon(inner)}" fill="#ffffff" fill-rule="evenodd"/>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(out, png);
console.log(`traced ${rows.length} rows of ${source}`);
console.log(`wrote ${out} (${png.length} bytes)`);
