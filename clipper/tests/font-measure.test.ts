import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCaptionStyle } from "../shared/caption-styles";
import { FONT_WIDTHS } from "../server/font-metrics";
import { measureFont } from "../server/fonts";
import { ffmpegAvailable } from "../server/media";
import { textWidth } from "../server/overlays";

// Brand fonts are measured when they're uploaded, so captions and overlays
// in them fit as tightly as in the bundled fonts (instead of the cautious
// bundled-maximum + 30% estimate).
describe("brand font metrics", () => {
  it.skipIf(!ffmpegAvailable())("measures a font through libass like the bundled table", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-"));
    fs.copyFileSync(path.resolve("fonts/Anton-Regular.ttf"), path.join(dir, "x.ttf"));
    const widths = await measureFont(dir, "Anton");
    fs.rmSync(dir, { recursive: true, force: true });
    expect(widths).toBeDefined();
    for (const ch of ["M", "a", "W", "i", "0", " "]) expect(widths![ch], ch).toBeCloseTo(FONT_WIDTHS.Anton[ch], 1);
  }, 60_000);

  it.skipIf(!ffmpegAvailable())("says so when the renderer can't find the font by its name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-"));
    fs.copyFileSync(path.resolve("fonts/Anton-Regular.ttf"), path.join(dir, "x.ttf"));
    expect(await measureFont(dir, "Totally Missing Font Name")).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("uses a brand font's measured widths in captions and overlays", () => {
    const widths = Object.fromEntries(Object.entries(FONT_WIDTHS.Anton).map(([c, w]) => [c, w]));
    const brand = { font: "Acme Sans", fonts: [{ id: "f1", family: "Acme Sans", key: "k", file: "f1.ttf", widths }] };
    const st = resolveCaptionStyle(brand, { style: "bold-pop" });
    expect(st.font).toBe("Acme Sans");
    expect(st.fontWidths).toBe(widths);
    expect(textWidth("Octane", 100, "Acme Sans", st.fontWidths)).toBeCloseTo(textWidth("Octane", 100, "Anton"), 5);
    // Without measurements, the cautious estimate is wider.
    expect(textWidth("Octane", 100, "Acme Sans")).toBeGreaterThan(textWidth("Octane", 100, "Anton"));
  });
});
