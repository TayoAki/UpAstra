import fs from "node:fs";
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
