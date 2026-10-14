import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze, classifyHook, comparableViews, playbookFrom, testShare } from "../shared/learning";
import type { Clip, HookStyle, Post } from "../shared/types";
import { createApp } from "../server/app";
import { initAuth } from "../server/auth";
import { useMemoryBackend } from "../server/db";
import { extractWithRules } from "../server/extract";
import { rulesInsights } from "../server/insights";
import { planClips } from "../server/scripts";
import { setAISimulated } from "../server/llm";

const H = 3600_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function clip(id: string, hook: string, hookStyle?: HookStyle): Clip {
  return {
    id, campaignId: "camp", title: hook, angle: "", hook, narration: "", onScreenText: [], cta: "", lengthSec: 20, caption: "", hashtags: [],
    shots: [{ moment: "goal", seconds: 5 }, { moment: "save", seconds: 5 }, { moment: "win", seconds: 5 }],
    status: "posted", qa: { pass: true, checks: [] }, model: "rules", cost: 0, createdAt: iso(NOW), updatedAt: iso(NOW),
    traits: hookStyle ? { hookStyle, format: "montage" } : undefined,
  };
}

let n = 0;
function post(clipId: string | undefined, views: number, ageH = 96, account = "main"): Post {
  const posted = NOW - ageH * H;
  return {
    id: `p${n++}`, campaignId: "camp", clipId, platform: "tiktok", account, url: "", postedAt: iso(posted), status: "live",
    metrics: { views, likes: 0, comments: 0, shares: 0 }, metricsUpdatedAt: iso(NOW), notes: "",
  };
}

describe("hook styles", () => {
  it.each([
    ["POV: you finally hit the wall shot", "pov"],
    ["How to win every kickoff in Car League", "how-to"],
    ["3 shots every new player should learn", "number"],
    ["Can you score from the wall?", "question"],
    ["I challenged my friend to car soccer", "challenge"],
    ["I was down 3-0 and then this happened", "story"],
    ["Someone made Rocket League in Roblox…", "reveal"],
    ["This is the best soccer game on Roblox", "bold-claim"],
    ["Car League gameplay", "other"],
  ])("%s → %s", (hook, style) => expect(classifyHook(hook)).toBe(style));
});

describe("comparable views", () => {
  it("ignores posts under a day old", () => {
    expect(comparableViews(post(undefined, 900, 10), NOW)).toBeUndefined();
  });
  it("uses the snapshot closest to 3 days, not the latest number", () => {
    const p = post(undefined, 50_000, 240);
    const t0 = Date.parse(p.postedAt);
    p.history = [
      { views: 800, likes: 0, comments: 0, shares: 0, at: iso(t0 + 12 * H) },
      { views: 5_000, likes: 0, comments: 0, shares: 0, at: iso(t0 + 70 * H) },
      { views: 50_000, likes: 0, comments: 0, shares: 0, at: iso(t0 + 240 * H) },
    ];
    p.metricsUpdatedAt = iso(t0 + 240 * H);
    expect(comparableViews(p, NOW)).toBe(5_000);
  });
});

describe("analysis", () => {
  it("scores each post against its own account, so a big account doesn't make its hooks look better", () => {
    const clips = [clip("q", "Can you score from the wall?", "question"), clip("c", "I challenged my friend", "challenge")];
    const posts = [
      // Big account: everything ~100k; the challenge clip did 2× its normal.
      ...[100_000, 100_000, 100_000].map((v) => post("q", v, 96, "big")),
      post("c", 200_000, 96, "big"),
      // Small account: ~1k normal, same pattern.
      ...[1_000, 1_000, 1_000].map((v) => post("q", v, 96, "small")),
      post("c", 2_000, 96, "small"),
    ];
    const r = analyze({ clips, posts }, "all", NOW);
    const hooks = r.dimensions.find((d) => d.id === "hookStyle")!.stats;
    expect(hooks[0].value).toBe("challenge");
    expect(hooks.find((s) => s.value === "question")!.lift).toBeLessThan(1.05);
    expect(r.maturePosts).toBe(8);
  });

  it("pulls thin data toward normal: one lucky post isn't a pattern", () => {
    const clips = [clip("a", "Can you score?", "question"), clip("b", "POV: kickoff", "pov")];
    const posts = [...Array.from({ length: 6 }, () => post("a", 1_000)), post("b", 20_000)];
    const r = analyze({ clips, posts }, "all", NOW);
    const pov = r.dimensions.find((d) => d.id === "hookStyle")!.stats.find((s) => s.value === "pov")!;
    expect(pov.confidence).toBe("too-early");
    expect(pov.lift).toBeLessThan(3); // raw ratio is ~19×
    expect(r.playbook.proven.find((p) => p.value === "pov")).toBeUndefined();
  });

  it("builds a playbook from repeated wins and losses", () => {
    const clips = [clip("w", "I challenged my friend", "challenge"), clip("l", "Car League gameplay", "other")];
    const posts = [...Array.from({ length: 8 }, () => post("w", 3_000)), ...Array.from({ length: 8 }, () => post("l", 600))];
    const r = analyze({ clips, posts }, "all", NOW);
    expect(r.playbook.proven.map((p) => p.value)).toContain("challenge");
    expect(r.playbook.weak.map((p) => p.value)).toContain("other");
    expect(r.playbook.untested.map((u) => u.value)).toContain("pov");
    expect(r.playbook.winningHooks).toContain("I challenged my friend");
    expect(testShare(5, r.playbook)).toBe(2);
    expect(testShare(5, playbookFrom([], []))).toBe(5);

    const ins = rulesInsights(r);
    expect(ins.doMore.join(" ")).toMatch(/Challenge/);
    expect(ins.stopDoing.join(" ")).toMatch(/Other/);
  });
});

describe("planner", () => {
  it("leans on proven hooks, avoids weak ones and spends the test share on untested ones (no-AI mode too)", async () => {
    setAISimulated(true);
    const text = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8");
    const c = { id: "camp", name: "Car League", status: "active", source: { kind: "text", text }, brief: extractWithRules(text), extractedBy: "rules", footage: [], notes: "", createdAt: iso(NOW), updatedAt: iso(NOW) } as const;
    const playbook = {
      proven: [{ dimension: "hookStyle", value: "challenge", label: "Hook style: Challenge", lift: 1.4, posts: 9 }],
      weak: [{ dimension: "hookStyle", value: "bold-claim", label: "Hook style: Bold claim", lift: 0.7, posts: 8 }],
      untested: [{ dimension: "hookStyle", value: "pov", label: "Hook style: POV" }],
      winningHooks: [],
    };
    for (const offset of [0, 3, 7]) {
      const existing = Array.from({ length: offset }, (_, k) => clip(`e${k}`, "x"));
      const { clips } = await planClips({ ...c, footage: [] }, 4, existing, { playbook, tests: 1, basedOnPosts: 20 });
      expect(clips.map((x) => x.traits?.strategy)).toEqual(["proven", "proven", "proven", "test"]);
      for (const x of clips.slice(0, 3)) expect(x.traits?.hookStyle).toBe("challenge");
      expect(clips[3].traits?.hookStyle).toBe("pov");
      expect(new Set(clips.slice(0, 3).map((x) => x.hook)).size).toBeGreaterThan(1);
      for (const x of clips) expect(x.narration).not.toMatch(/\.\./);
    }
  });
});

describe("learning api", () => {
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

  it("snapshots metrics, reports, writes findings and tags new plans", async () => {
    let cookie = "";
    const call = async (path: string, method = "GET", body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      return { status: r.status, body: await r.json() };
    };
    await call("/api/auth/signup", "POST", { email: "learn@test.dev", password: "password123", name: "L" });
    const brief = fs.readFileSync(new URL("./fixtures/car-league-brief.txt", import.meta.url), "utf8").replace(/\(https:\/\/drive[^)]+\)/g, "");
    const id = (await call("/api/campaigns", "POST", { text: brief })).body.campaign.id;
    const first = (await call(`/api/campaigns/${id}/clips`, "POST", { count: 3 })).body.clips;
    // Nothing posted yet: no learning, so plans carry traits but no strategy.
    expect(first[0].traits.hookStyle).toBeTruthy();
    expect(first[0].traits.strategy).toBeUndefined();

    const postedAt = new Date(Date.now() - 4 * 24 * H).toISOString();
    for (const [i, c] of first.entries()) await call("/api/posts", "POST", { campaignId: id, clipId: c.id, platform: "tiktok", account: "me", postedAt, metrics: { views: 1000 * (i + 1) } });
    const st = (await call("/api/state")).body;
    const p = st.posts[0];
    expect(p.history).toHaveLength(1);
    const upd = await call(`/api/posts/${p.id}`, "PUT", { metrics: { views: 9000 } });
    expect(upd.body.posts.find((x: Post) => x.id === p.id).history).toHaveLength(2);

    const rep = await call(`/api/learning?scope=${id}`);
    expect(rep.status).toBe(200);
    expect(rep.body.report.maturePosts).toBe(3);
    expect((await call("/api/learning?scope=nope")).status).toBe(404);

    const ins = await call("/api/learning/insights", "POST", { scope: "all" });
    expect(ins.status).toBe(200);
    expect(ins.body.insights.model).toBe("rules");
    expect((await call("/api/state")).body.insights.all.basedOnPosts).toBe(3);

    // With posts to learn from, new plans say whether they repeat a win or test something.
    const next = (await call(`/api/campaigns/${id}/clips`, "POST", { count: 4 })).body.clips.slice(0, 4);
    expect(next.every((c: Clip) => c.traits?.strategy)).toBe(true);
  });
});
