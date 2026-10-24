import { describe, expect, it } from "vitest";
import { cardLines, findFont, renderPng, renderSvg } from "../src/card.js";
import { buildReport, type EvalRecord } from "../src/report.js";

const rec = (o: Partial<EvalRecord>): EvalRecord => ({
  source: "claude",
  project: "/p",
  tool: "bash",
  input: "x",
  action: "allow",
  rule: "default",
  layer: "builtin",
  ...o,
});

const report = buildReport([
  ...Array.from({ length: 3 }, () => rec({ action: "deny", rule: "git-force-push" })),
  rec({ action: "deny", tool: "read", rule: "secret-files" }),
  rec({ action: "deny", tool: "read", rule: "secret-files" }),
  ...Array.from({ length: 41 }, () => rec({ action: "allow" })),
]);

describe("cardLines", () => {
  it("summarizes the top blocked categories and commands allowed", () => {
    const lines = cardLines(report).map((l) => l.text);
    expect(lines).toContain("3 force pushes blocked");
    expect(lines).toContain("2 secret file reads blocked");
    expect(lines).toContain("41 commands allowed");
  });

  it("has a friendly line when nothing was blocked", () => {
    const clean = buildReport([rec({ action: "allow" })]);
    expect(cardLines(clean)[0].text).toContain("nothing blocked");
  });
});

describe("renderSvg", () => {
  const svg = renderSvg(report);
  it("is valid SVG containing the counts and the call to action", () => {
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain("3 force pushes blocked");
    expect(svg).toContain("npx @abelo9996/agent-fence report");
    expect(svg).toContain("counts only");
  });
  it("escapes text", () => {
    const s = renderSvg(buildReport([rec({ action: "deny", rule: "x<y&z" })]));
    expect(s).not.toMatch(/<text[^>]*>[^<]*<y/);
    expect(s).toContain("&amp;");
  });
});

describe("renderPng", () => {
  it.skipIf(!findFont())("rasterizes the SVG to a PNG buffer", async () => {
    const png = await renderPng(renderSvg(report));
    // PNG magic number
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(png.length).toBeGreaterThan(1000);
  });
});
