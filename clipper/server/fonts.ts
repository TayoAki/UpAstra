import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { BrandKit } from "../shared/caption-styles";
import { run } from "./media";
import { videoStore } from "./storage";

// Fonts for burned-in captions: the bundled OFL fonts (/fonts) plus the
// workspace's uploaded brand fonts, gathered into one folder for libass.
// Scripts the chosen font lacks (CJK, Arabic…) fall back to system Noto fonts.

export const bundledFontsDir = () => process.env.FONTS_DIR ?? path.resolve(process.cwd(), "fonts");

export async function prepareFonts(workDir: string, brand?: BrandKit): Promise<string> {
  const dir = path.join(workDir, "fonts");
  fs.mkdirSync(dir, { recursive: true });
  const bundled = bundledFontsDir();
  if (fs.existsSync(bundled)) for (const f of fs.readdirSync(bundled)) if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(bundled, f), path.join(dir, f));
  for (const f of brand?.fonts ?? []) {
    try {
      const r = await videoStore().read(f.key);
      await pipeline(r.stream, fs.createWriteStream(path.join(dir, f.file)));
    } catch (err) {
      console.error(`[fonts] couldn't load brand font ${f.family}:`, (err as Error).message);
    }
  }
  return dir;
}

/** A font file's family and full name, or undefined if it isn't a usable font. */
export async function fontInfo(file: string): Promise<{ family: string; fullName: string } | undefined> {
  try {
    const { stdout } = await run("fc-scan", ["--format", "%{family[0]}\\n%{fullname[0]}\\n", file], 20_000);
    const [family, fullName] = stdout.split("\n").map((s) => s.trim());
    return family ? { family, fullName: fullName || family } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How wide each printable ASCII character renders in libass for `family`
 * (a fraction of the ASS font size), measured from one rendered frame, as
 * scripts/measure-fonts.mjs does for the bundled fonts. Stored with an
 * uploaded brand font so captions and overlays in it fit tightly.
 */
export async function measureFont(fontsDir: string, family: string): Promise<Record<string, number> | undefined> {
  const widths = await measureFamily(fontsDir, family);
  if (!widths) return undefined;
  // If libass couldn't find the family by name, fontconfig substituted another
  // font: those widths aren't this font's (and the render won't use it either).
  substitute ??= measureFamily(fontsDir, "UGC No Such Font Family");
  const sub = await substitute;
  if (sub && Object.keys(widths).every((c) => Math.abs(widths[c] - (sub[c] ?? -1)) < 0.002)) return undefined;
  return widths;
}
let substitute: Promise<Record<string, number> | undefined> | undefined;

async function measureFamily(fontsDir: string, family: string): Promise<Record<string, number> | undefined> {
  const chars = Array.from({ length: 94 }, (_, i) => String.fromCharCode(32 + i)); // space … "}"
  const REP = 10, FS = 100, ROW = 140, W = 2400;
  const H = ROW * (chars.length + 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-"));
  try {
    // Each row: the character repeated between two bars; the last row is the bars alone.
    const escape = (c: string) => (c === "\\" ? "\\\\" : c === "{" ? "\\{" : c);
    const row = (i: number, body: string) => `Dialogue: 0,0:00:00.00,0:00:01.00,M,,0,0,0,,{\\an4\\pos(10,${i * ROW + ROW / 2})}|${body}|`;
    const ass = [
      "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 2", "", "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      // Bold exactly as captions draw it (DejaVu faces are drawn bold, see buildAss).
      `Style: M,${family.replace(/,/g, "")},${FS},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${/^DejaVu/i.test(family) ? -1 : 0},0,0,0,100,100,0,0,1,0,0,4,0,0,0,1`, "", "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...chars.map((c, i) => row(i, escape(c).repeat(REP))),
      row(chars.length, ""),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "m.ass"), ass);
    const out = path.join(dir, "m.gray");
    const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`, "-frames:v", "1", "-vf", `ass='${esc(path.join(dir, "m.ass"))}':fontsdir='${esc(fontsDir)}',format=gray`, "-f", "rawvideo", out], 60_000);
    const raw = fs.readFileSync(out);
    const extent = (r: number) => {
      let lo = -1, hi = -1;
      for (let y = r * ROW; y < (r + 1) * ROW; y++)
        for (let x = 0; x < W; x++)
          if (raw[y * W + x] > 128) {
            if (lo < 0 || x < lo) lo = x;
            if (x > hi) hi = x;
          }
      return hi - lo;
    };
    const bars = extent(chars.length);
    if (bars <= 0) return undefined;
    const widths: Record<string, number> = {};
    chars.forEach((c, i) => (widths[c] = Math.max(0, Math.round(((extent(i) - bars) / REP / FS) * 1000) / 1000)));
    widths["~"] = widths["-"];
    return widths;
  } catch (err) {
    console.error(`[fonts] couldn't measure "${family}":`, (err as Error).message);
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
