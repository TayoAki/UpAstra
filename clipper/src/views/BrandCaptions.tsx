import { useRef, useState } from "react";
import { Check, Trash2, Upload } from "lucide-react";
import { BUNDLED_FONTS, CAPTION_STYLES, DEFAULT_CAPTION_STYLE, resolveCaptionStyle, type BrandKit } from "../../shared/caption-styles";
import { api } from "../api";
import { CaptionPreview, useBrandFonts } from "../components/CaptionPreview";
import { uploadFile } from "../components/Upload";
import { Panel } from "../components/ui";
import { useApp } from "../store";

const COLOR_FIELDS: { key: keyof NonNullable<BrandKit["colors"]>; label: string; hint: string }[] = [
  { key: "text", label: "Caption text", hint: "Main caption colour" },
  { key: "highlight", label: "Highlight", hint: "The spoken word in karaoke styles" },
  { key: "outline", label: "Outline", hint: "Stroke around the letters" },
  { key: "accent", label: "Call to action", hint: "The card at the end of each clip" },
];

/** Settings → Brand & captions: default caption style, fonts and colours for every render. */
export function BrandCaptions() {
  const { state, run, setState, toast, busy } = useApp();
  const brand = state?.brand ?? {};
  useBrandFonts(brand);
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const current = brand.captionStyle ?? DEFAULT_CAPTION_STYLE;
  const set = (b: Partial<Record<keyof BrandKit, unknown>>, ok?: string) => run(() => api.updateBrand(b), ok);

  const upload = async (file?: File) => {
    if (!file) return;
    setPct(0);
    try {
      setState(await uploadFile("/api/brand/fonts", file, setPct));
      toast(`Font "${file.name}" added`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPct(null);
      if (input.current) input.current.value = "";
    }
  };

  const fonts = [...(brand.fonts ?? []).map((f) => ({ family: f.family, mine: f })), ...BUNDLED_FONTS.map((f) => ({ family: f.family, mine: undefined }))];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Brand & captions</h1>
          <p className="muted" style={{ margin: 0 }}>
            Every render uses these: captions timed word by word to the voiceover, in your style, font and colours. A campaign can pick its own style on its Brief tab.
          </p>
        </div>
      </div>

      <Panel title="Caption style">
        <div className="style-grid">
          {CAPTION_STYLES.map((s) => {
            const resolved = resolveCaptionStyle(brand, { style: s.id });
            return (
              <button key={s.id} className={`style-card ${current === s.id ? "on" : ""}`} disabled={busy} onClick={() => set({ captionStyle: s.id }, `Default style: ${s.name}`)}>
                <CaptionPreview style={resolved} height={120} />
                <div className="row between" style={{ padding: "8px 10px 2px" }}>
                  <strong className="small">{s.name}</strong>
                  {current === s.id && <Check size={14} className="pos" />}
                </div>
                <div className="small faint" style={{ padding: "0 10px 10px", textAlign: "left" }}>
                  {s.description}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Font">
        <div className="row wrap">
          <select className="select" style={{ width: "auto", minWidth: 220 }} value={brand.font ?? ""} disabled={busy} onChange={(e) => set({ font: e.target.value || null }, "Font updated")}>
            <option value="">Each style's own font</option>
            {fonts.map((f) => (
              <option key={f.family} value={f.family}>
                {f.family}
                {f.mine ? " (yours)" : ""}
              </option>
            ))}
          </select>
          <input ref={input} type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <button className="btn" disabled={pct !== null} onClick={() => input.current?.click()}>
            <Upload size={14} /> {pct !== null ? `Uploading ${pct}%` : "Upload brand font"}
          </button>
        </div>
        {!!brand.fonts?.length && (
          <table className="table mt">
            <tbody>
              {brand.fonts.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontFamily: `"${f.family}"`, fontSize: 18 }}>{f.family}</td>
                  <td className="num">
                    <button className="btn sm ghost danger" title="Remove" onClick={() => confirm(`Remove ${f.family}?`) && run(() => api.deleteBrandFont(f.id), "Font removed")}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small faint" style={{ marginBottom: 0 }}>
          TTF or OTF, up to 10 fonts. Use fonts you're licensed to embed in videos. Letters the font doesn't have (other alphabets) fall back to Noto automatically.
        </p>
      </Panel>

      <Panel title="Colours & casing">
        <div className="form-grid">
          {COLOR_FIELDS.map((f) => {
            const v = brand.colors?.[f.key];
            return (
              <label key={f.key} className="field">
                {f.label}
                <span className="row">
                  <input
                    type="color"
                    value={v ?? (f.key === "accent" ? "#e5484d" : f.key === "outline" ? "#000000" : f.key === "highlight" ? "#ffd60a" : "#ffffff")}
                    onChange={(e) => set({ colors: { ...brand.colors, [f.key]: e.target.value } })}
                    style={{ width: 44, height: 32, padding: 0, border: 0, background: "none" }}
                  />
                  <span className="small faint">{v ? v : "style default"}</span>
                </span>
                <span className="small faint">{f.hint}</span>
              </label>
            );
          })}
          <label className="field">
            Casing
            <select className="select" value={brand.uppercase === undefined ? "" : brand.uppercase ? "upper" : "as-written"} onChange={(e) => set({ uppercase: e.target.value === "" ? null : e.target.value === "upper" })}>
              <option value="">Style default</option>
              <option value="upper">ALWAYS UPPERCASE</option>
              <option value="as-written">As written</option>
            </select>
          </label>
        </div>
        {brand.colors && (
          <button className="btn sm ghost mt" onClick={() => set({ colors: null }, "Colours reset")}>
            Reset colours
          </button>
        )}
      </Panel>
    </>
  );
}
