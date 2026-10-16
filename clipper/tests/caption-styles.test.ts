import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCaptionStyle } from "../shared/caption-styles";
import { assColor, buildAss } from "../server/captions";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { setAISimulated } from "../server/llm";

describe("caption styles", () => {
  it("layers preset ← brand kit ← campaign", () => {
    const brand = { captionStyle: "karaoke", font: "Anton", colors: { highlight: "#FF0000", text: "nope" }, uppercase: false };
    const s = resolveCaptionStyle(brand, { wordsPerCaption: 2, size: 999 });
    expect(s).toMatchObject({ id: "karaoke", font: "Anton", highlight: "#FF0000", color: "#FFFFFF", uppercase: false, wordsPerCaption: 2, size: 220 });
    expect(resolveCaptionStyle(undefined, { style: "missing" }).id).toBe("bold-pop");
    expect(resolveCaptionStyle(brand, { style: "boxed" }).id).toBe("boxed");
  });

  it("converts colours to ASS (alpha inverted)", () => {
    expect(assColor("#FFD60A")).toBe("&H000AD6FF");
    expect(assColor("#000000CC")).toBe("&H33000000");
  });

  it("writes karaoke as one event per word with the spoken word highlighted", () => {
    const words = [
      { text: "score", start: 0, end: 0.4 },
      { text: "from", start: 0.4, end: 0.8 },
      { text: "here", start: 0.8, end: 1.2 },
    ];
    const ass = buildAss({ hook: "Hi", captions: [{ text: "score from here", start: 0, end: 1.2, words }], cta: "", ctaFrom: 9, duration: 5, style: resolveCaptionStyle(undefined, { style: "hormozi" }) });
    const ev = ass.split("\n").filter((l) => l.includes(",Cap,"));
    expect(ev).toHaveLength(3);
    expect(ev[1]).toContain("0:00:00.40,0:00:00.80");
    expect(ev[1]).toMatch(/SCORE \{\\c&H005FE739\}FROM\{\\c&H00FFFFFF\} HERE/);
    expect(ass).toContain("Style: Cap,Anton,112,");
  });

  it("joins words without spaces for scripts that don't use them (no language needed)", () => {
    const ass = buildAss({ hook: "", captions: [{ text: "你好世界", start: 0, end: 1, words: [{ text: "你好", start: 0, end: 0.5 }, { text: "世界", start: 0.5, end: 1 }] }], cta: "", ctaFrom: 9, duration: 2, style: resolveCaptionStyle(undefined, { style: "bold-pop" }) });
    expect(ass).toContain("}你好世界");
  });
});

describe("brand kit api", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(() => {
    useMemoryBackend();
    setAISimulated(true);
    initAuth();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("saves the brand kit, checks fonts, and lets a campaign pick its style", async () => {
    const su = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "brand@test.dev", password: "password123" }) });
    const cookie = su.headers.get("set-cookie")!.split(";")[0];
    const call = (p: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + p, { method, headers: { cookie, ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers }, body: body instanceof Uint8Array ? (body as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined });

    const r = await call("/api/brand", "PUT", { captionStyle: "neon", colors: { highlight: "#00ff00", text: "red" }, uppercase: false });
    const st = await r.json();
    expect(st.brand).toMatchObject({ captionStyle: "neon", colors: { highlight: "#00FF00" }, uppercase: false });
    expect(st.brand.colors.text).toBeUndefined();
    expect((await call("/api/brand", "PUT", { font: "Comic Sans Unknown" })).status).toBe(400);
    expect((await call("/api/brand", "PUT", { font: "Anton" })).status).toBe(200);

    // Fonts: wrong type, not a font, a real font.
    expect((await call("/api/brand/fonts", "POST", new Uint8Array(2000), { "X-File-Name": "x.png" })).status).toBe(415);
    expect((await call("/api/brand/fonts", "POST", new Uint8Array(2000).fill(7), { "X-File-Name": "fake.ttf" })).status).toBe(422);
    const ttf = fs.readFileSync(new URL("../fonts/BebasNeue-Regular.ttf", import.meta.url));
    const up = await call("/api/brand/fonts", "POST", new Uint8Array(ttf), { "X-File-Name": "MyBrand.ttf" });
    expect(up.status).toBe(201);
    const font = (await up.json()).brand.fonts[0];
    expect(font.family).toBe("Bebas Neue");
    expect((await call(`/api/brand/fonts/${font.id}/file`)).headers.get("content-type")).toBe("font/ttf");
    expect((await fetch(`${base}/fonts/Anton-Regular.ttf`)).status).toBe(200);

    const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8");
    const camp = (await (await call("/api/campaigns", "POST", { text: brief })).json()).campaign;
    const saved = await (await call(`/api/campaigns/${camp.id}`, "PUT", { captions: { style: "boxed", wordsPerCaption: 2, bogus: 1 } })).json();
    expect(saved.campaigns[0].captions).toEqual({ style: "boxed", wordsPerCaption: 2 });
  }, 60_000); // a font upload measures the font through libass
});
