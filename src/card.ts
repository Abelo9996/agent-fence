/**
 * Render a shareable card for a report: an SVG built in-process and a PNG
 * rasterized from it with @resvg/resvg-wasm (no system tools, no network). The
 * card shows counts only - never a command, path or secret - so it is safe to
 * post anywhere.
 */
import { createRequire } from "node:module";
import type { Report } from "./report.js";

const W = 1200;
const H = 630;

/** Brand-neutral palette, legible on the dark card. */
const COLOR = {
  bg: "#0d1117",
  panel: "#161b22",
  text: "#e6edf3",
  dim: "#8b949e",
  accent: "#58a6ff",
  deny: "#f85149",
  ask: "#d29922",
  allow: "#3fb950",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Up to four headline lines: denied/asked categories first, then "N commands allowed". */
export function cardLines(r: Report): { text: string; color: string }[] {
  if (!r.headline.length) {
    return [{ text: `${r.byAction.allow} calls allowed, nothing blocked`, color: COLOR.allow }];
  }
  const lines: { text: string; color: string }[] = [];
  for (const h of r.headline.slice(0, 3)) {
    const verb = h.action === "deny" ? "blocked" : "held for approval";
    lines.push({ text: `${h.count} ${h.label} ${verb}`, color: h.action === "deny" ? COLOR.deny : COLOR.ask });
  }
  if (r.commandsAllowed) lines.push({ text: `${r.commandsAllowed} commands allowed`, color: COLOR.allow });
  return lines;
}

export function renderSvg(r: Report): string {
  const lines = cardLines(r);
  const title = "What my coding agent tried" + (r.since ? ` (last ${r.since})` : " this week");
  const rowH = 72;
  const startY = 256;
  const rows = lines
    .map((l, i) => {
      const y = startY + i * rowH;
      return `
    <circle cx="90" cy="${y - 10}" r="11" fill="${l.color}"/>
    <text x="128" y="${y}" font-size="46" font-weight="600" fill="${COLOR.text}">${esc(l.text)}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="${COLOR.bg}"/>
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="20" fill="${COLOR.panel}"/>
  <text x="90" y="128" font-size="30" font-weight="700" letter-spacing="2" fill="${COLOR.accent}">AGENT-FENCE</text>
  <text x="90" y="186" font-size="42" font-weight="700" fill="${COLOR.text}">${esc(title)}</text>
  ${rows}
  <text x="90" y="534" font-size="26" fill="${COLOR.dim}">counts only - no commands, paths or secrets</text>
  <text x="90" y="578" font-size="30" font-weight="600" fill="${COLOR.accent}">check yours:  npx agent-fence report</text>
</svg>
`;
}

/**
 * The wasm build of resvg cannot read fonts from disk, so a font buffer has to
 * be handed in. We load one common sans-serif from the OS (reading a file, not
 * shelling out). AGENT_FENCE_FONT overrides the choice. Candidates cover macOS,
 * Linux and Windows.
 */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Geneva.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/segoeui.ttf",
];

export function findFont(): string | undefined {
  const { existsSync } = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const env = process.env.AGENT_FENCE_FONT;
  if (env && existsSync(env)) return env;
  return FONT_CANDIDATES.find((p) => existsSync(p));
}

let wasmReady: Promise<unknown> | null = null;

/** Rasterize the SVG to a PNG buffer. Loads the wasm module once. */
export async function renderPng(svg: string): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const resvg = require("@resvg/resvg-wasm") as {
    initWasm: (b: Uint8Array) => Promise<unknown>;
    Resvg: new (s: string, o?: unknown) => { render: () => { asPng: () => Uint8Array } };
  };
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  if (!wasmReady) wasmReady = resvg.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  await wasmReady;
  const font = findFont();
  if (!font) throw new Error("no usable font found for the PNG (the .svg is still written); set AGENT_FENCE_FONT to a .ttf/.ttc path");
  const r = new resvg.Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: false, fontBuffers: [readFileSync(font)], defaultFontFamily: "sans-serif" },
  });
  return Buffer.from(r.render().asPng());
}
