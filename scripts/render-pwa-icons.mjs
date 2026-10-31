// Renders scripts/pwa-default-icon.svg into the four fallback PWA icon PNGs in
// /public, used until the agency owner uploads one (Agency > Settings > Mobile
// app icon). Most installs never need to run this.
//
// @resvg/resvg-js isn't an app dependency, so if the import fails:
//   pnpm add -D @resvg/resvg-js && node scripts/render-pwa-icons.mjs
//
// The SVG has its own #18181b background; padded variants nest it in a
// same-colour canvas so there's no seam and the mark stays inside Android's
// maskable safe zone / Apple's opaque square.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

function render(svg, viewBox, width, pad = 0) {
  if (pad === 0) {
    return new Resvg(svg, { fitTo: { mode: "width", value: width } })
      .render()
      .asPng();
  }
  const inner = Math.round(width * (1 - 2 * pad));
  const offset = Math.round((width - inner) / 2);
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}">
    <rect width="${width}" height="${width}" fill="#18181b"/>
    <svg x="${offset}" y="${offset}" width="${inner}" height="${inner}" viewBox="${viewBox}">${svg
      .replace(/<\/?svg[^>]*>/g, "")
      .trim()}</svg>
  </svg>`;
  return new Resvg(wrapper, { fitTo: { mode: "width", value: width } })
    .render()
    .asPng();
}

// Default mark (green "my CRM", carries its own dark bg).
const myCrm = readFileSync(join(here, "pwa-default-icon.svg"), "utf8");
writeFileSync(join(publicDir, "icon-192.png"), render(myCrm, "0 0 512 512", 192));
writeFileSync(join(publicDir, "icon-512.png"), render(myCrm, "0 0 512 512", 512));
writeFileSync(
  join(publicDir, "icon-maskable-512.png"),
  render(myCrm, "0 0 512 512", 512, 0.15),
);
writeFileSync(
  join(publicDir, "apple-touch-icon.png"),
  render(myCrm, "0 0 512 512", 180, 0.1),
);

// LeadStack chevron set, used by the manifest only in "leadstack" mode.
// Transparent source, so every size goes through the dark-bg wrapper.
const chevron = readFileSync(join(publicDir, "leadstack-mark.svg"), "utf8");
writeFileSync(
  join(publicDir, "leadstack-icon-192.png"),
  render(chevron, "0 0 64 64", 192, 0.12),
);
writeFileSync(
  join(publicDir, "leadstack-icon-512.png"),
  render(chevron, "0 0 64 64", 512, 0.12),
);
writeFileSync(
  join(publicDir, "leadstack-icon-maskable-512.png"),
  render(chevron, "0 0 64 64", 512, 0.18),
);
writeFileSync(
  join(publicDir, "leadstack-apple-touch-icon.png"),
  render(chevron, "0 0 64 64", 180, 0.14),
);
console.log("wrote my-CRM set (icon-*) + LeadStack set (leadstack-icon-*)");
