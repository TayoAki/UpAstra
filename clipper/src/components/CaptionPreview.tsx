import { useEffect } from "react";
import type { BrandKit, CaptionStyle } from "../../shared/caption-styles";

/** Make the workspace's uploaded brand fonts available to previews. */
export function useBrandFonts(brand: BrandKit | undefined) {
  const ids = (brand?.fonts ?? []).map((f) => f.id).join(",");
  useEffect(() => {
    for (const f of brand?.fonts ?? []) {
      if ([...document.fonts].some((x) => x.family === f.family)) continue;
      const face = new FontFace(f.family, `url(/api/brand/fonts/${f.id}/file)`);
      face.load().then((x) => document.fonts.add(x), () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
}

const SAMPLE = ["Score", "from", "the", "wall", "in", "Car", "League", "today"];

/**
 * A close CSS stand-in for how a style burns in: same font, colours, outline,
 * box and casing. The second word is shown as the spoken one.
 */
export function CaptionPreview({ style, words = SAMPLE, height = 150 }: { style: CaptionStyle; words?: string[]; height?: number }) {
  const scale = height / 640; // preview area ≈ the bottom third of a 1920px-tall frame
  const shown = words.slice(0, Math.max(1, style.wordsPerCaption));
  const stroke = Math.max(1, style.outlineWidth * scale);
  const textShadow = style.box
    ? undefined
    : [
        // Outline as stacked shadows (text-stroke eats into the glyphs).
        ...[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `${(Math.cos((a * Math.PI) / 180) * stroke).toFixed(1)}px ${(Math.sin((a * Math.PI) / 180) * stroke).toFixed(1)}px 0 ${style.outline}`),
        style.glow ? `0 0 ${8 * stroke}px ${style.outline}` : "",
        style.shadow ? `${style.shadow * scale * 2}px ${style.shadow * scale * 2}px 0 rgba(0,0,0,.6)` : "",
      ]
        .filter(Boolean)
        .join(",");
  const boxColor = style.box ? `#${style.box.slice(1, 7)}${style.box.length > 7 ? style.box.slice(7, 9) : "ff"}` : undefined;
  return (
    <div className="cap-preview" style={{ height }}>
      <span
        style={{
          fontFamily: `"${style.font}", "Poppins", system-ui, sans-serif`,
          fontSize: Math.max(10, style.size * scale),
          color: style.color,
          textTransform: style.uppercase ? "uppercase" : "none",
          textShadow,
          background: boxColor,
          padding: boxColor ? `${2 * scale * 10}px ${4 * scale * 10}px` : undefined,
          borderRadius: boxColor ? 4 : undefined,
          lineHeight: 1.15,
        }}
      >
        {shown.map((w, i) => (
          <span key={i} style={{ color: style.animation === "karaoke" && i === 1 ? style.highlight : undefined }}>
            {i ? " " : ""}
            {w}
          </span>
        ))}
      </span>
    </div>
  );
}
