// Renders public/notification-badge.png, the small icon Android draws in the
// status bar for a push notification.
//
// Android uses only the alpha channel of that image and paints it white, so a
// full-colour icon — which is what the service worker used to pass — arrives as
// a white square. What is needed is a silhouette: white on transparent, with no
// colour and no fine detail, since the system renders it about 24px tall.
//
// The shape is the app icon's own outline (a rounded frame that tapers at the
// bottom) drawn as a thick stroke rather than the detailed quadrants inside it,
// which would be unreadable at that size.
//
// Run with: node scripts/make-notification-badge.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "public", "notification-badge.png");

// 96x96 with ~10px of breathing room, which is the safe area Android crops to.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <path d="M26 12 H70 A12 12 0 0 1 82 24 V58 C82 74 68 84 48 84 C28 84 14 74 14 58 V24 A12 12 0 0 1 26 12 Z
           M30 22 A4 4 0 0 0 26 26 V58 C26 66 34 72 48 72 C62 72 70 66 70 58 V26 A4 4 0 0 0 66 22 Z"
        fill="#ffffff" fill-rule="evenodd"/>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
