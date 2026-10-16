import { describe, expect, it } from "vitest";
import { displayText, displayTimed, hasMarkup, momentNames, parseNarration, spokenText } from "../shared/markup";
import { cueInScript } from "../shared/overlays";
import { placeOverlays } from "../server/overlays";

// B5.1: the voice says one thing, the captions show another, and overlays can
// cue on named moments instead of guessing at words.
const n = "Get @{deal}<$5|five dollars> off <CarLeague|Car League> today.";

describe("narration markup", () => {
  it("splits what's said from what's shown", () => {
    expect(spokenText(n)).toBe("Get five dollars off Car League today.");
    expect(displayText(n)).toBe("Get $5 off CarLeague today.");
    expect(momentNames(n)).toEqual(["deal"]);
    expect(spokenText("No markup here.")).toBe("No markup here.");
    expect(displayText("No markup here.")).toBe("No markup here.");
  });

  it("times shown words from the spoken words they stand for", () => {
    const p = parseNarration(n);
    const said = ["Get", "five", "dollars", "off", "Car", "League", "today."].map((t, i) => ({ text: t, start: i, end: i + 0.9 }));
    const { words, moments } = displayTimed(p, said);
    expect(words.map((w) => w.text)).toEqual(["Get", "$5", "off", "CarLeague", "today."]);
    expect(words[1]).toMatchObject({ start: 1, end: 2.9 }); // "$5" spans "five dollars"
    expect(words[3]).toMatchObject({ start: 4, end: 5.9 });
    expect(moments.deal).toBe(1); // the moment is where "$5" is said
  });

  it("lets overlays cue on a moment, and validates moment names", () => {
    expect(cueInScript("@deal", n)).toBe(true);
    expect(cueInScript("@nope", n)).toBe(false);
    expect(cueInScript("$5 off", n)).toBe(true); // shown words are fine cues too
    const words = [{ text: "Get", start: 0, end: 0.9 }, { text: "$5", start: 1, end: 2.9 }];
    const { placed } = placeOverlays([{ id: "x", kind: "text", cue: "@deal", text: "SALE" }], words, 10, 9, { deal: 1 });
    expect(placed[0].start).toBe(1);
  });

  it("knows plain narration (which render passes through untouched)", () => {
    expect(hasMarkup("这个游戏太好玩了。现在就玩吧！")).toBe(false);
    expect(hasMarkup("Price: $5 | great")).toBe(false);
    expect(hasMarkup(n)).toBe(true);
  });
});
