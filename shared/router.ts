import { MODEL_CATALOG, getModel, stepCost } from "./catalog";
import type { AutonomyPolicy, Lane, ModelSpec, RecipeStep } from "./types";

// The model router turns the catalog into a production system: for every step
// it answers the four questions (what medium, new vs repair, explore vs final,
// what must not change), picks the best allowed model and explains why.

const LANE_FALLBACK: Record<Lane, Lane[]> = {
  people: ["product"],
  product: ["typography", "people"],
  typography: ["product"],
  repair: ["product", "typography"],
  "explore-image": ["product", "typography"],
  "explore-video": ["speech", "hero-video"],
  cinematic: ["hero-video", "explore-video"],
  "hero-video": ["cinematic", "speech", "explore-video"],
  speech: ["hero-video", "explore-video"],
  "motion-transfer": ["hero-video", "cinematic"],
  finishing: [],
};

const LANE_WHY: Record<Lane, string> = {
  people: "people with taste — editorial portraits and identity",
  product: "a product scene that must keep the subject recognizable",
  typography: "real words and layout are part of the deliverable",
  repair: "the asset is close — fix one detail and preserve everything else",
  "explore-image": "cheap still exploration before spending real money",
  "explore-video": "cheap motion tests for hooks, openings and camera ideas",
  cinematic: "a longer scene that develops over time with multiple references",
  "hero-video": "the hero shot — camera movement and physical realism",
  speech: "a person must speak with audio generated in the scene",
  "motion-transfer": "an exact movement reference must be copied",
  finishing: "finishing for publish-ready delivery",
};

export type PolicyGate = Pick<AutonomyPolicy, "blockedFamilies" | "blockedOrigins">;

export function modelBlockReason(m: ModelSpec, policy: PolicyGate): string | null {
  if (policy.blockedFamilies.includes(m.family)) return `family "${m.family}" is blocked by autonomy policy`;
  if (policy.blockedOrigins.includes(m.origin)) return `models from ${m.origin} are blocked by autonomy policy`;
  return null;
}

function finishingCandidates(step: Pick<RecipeStep, "kind" | "preserve">): ModelSpec[] {
  const ids =
    step.kind === "video" && step.preserve === "person"
      ? ["lipsync-studio", "captions-export"]
      : step.kind === "video" && step.preserve === "words"
        ? ["captions-export", "topaz-upscale"]
        : step.kind === "video"
          ? ["topaz-upscale", "captions-export"]
          : ["topaz-upscale"];
  return ids.map((id) => getModel(id)!).filter(Boolean);
}

function rank(models: ModelSpec[], step: Pick<RecipeStep, "intent" | "units">): ModelSpec[] {
  const cost = (m: ModelSpec) => stepCost(m, step.units);
  return [...models].sort((a, b) =>
    step.intent === "explore" ? cost(a) - cost(b) || b.quality - a.quality : b.quality - a.quality || cost(a) - cost(b),
  );
}

export interface RouteOption {
  modelId: string;
  name: string;
  cost: number;
  blocked: string | null;
  inLane: boolean;
}

export interface RouteDecision {
  modelId: string | null;
  rationale: string;
  options: RouteOption[];
}

export function routeStep(
  step: Pick<RecipeStep, "lane" | "kind" | "intent" | "preserve" | "units" | "label">,
  policy: PolicyGate,
): RouteDecision {
  const primary =
    step.lane === "finishing"
      ? finishingCandidates(step)
      : MODEL_CATALOG.filter((m) => m.lanes.includes(step.lane) && m.kind === step.kind);
  const fallbacks = [
    ...new Set(LANE_FALLBACK[step.lane].flatMap((lane) => MODEL_CATALOG.filter((m) => m.lanes.includes(lane) && m.kind === step.kind && !primary.includes(m)))),
  ];

  // Finishing candidates are already in order of fit for the step.
  const ordered = step.lane === "finishing" ? primary : rank(primary, step);
  const options: RouteOption[] = [...ordered, ...rank(fallbacks, step)].map((m) => ({
    modelId: m.id,
    name: m.name,
    cost: stepCost(m, step.units),
    blocked: modelBlockReason(m, policy),
    inLane: primary.includes(m),
  }));

  const pick = options.find((o) => !o.blocked);
  if (!pick) {
    return {
      modelId: null,
      rationale: `No allowed model can do "${step.label}" — every candidate is blocked by policy. Unblock a family or change the recipe.`,
      options,
    };
  }
  const model = getModel(pick.modelId)!;
  const why = [
    `${step.intent === "explore" ? "Exploring" : step.intent === "repair" ? "Repairing" : step.intent === "finish" ? "Finishing" : "Final render"}: ${LANE_WHY[step.lane]}.`,
    `${model.name} — ${model.strengths}`,
    step.preserve !== "none" ? `Must preserve: ${step.preserve}. Watch out: ${model.watchOuts}` : `Watch out: ${model.watchOuts}`,
  ];
  if (!pick.inLane) {
    const skipped = options.filter((o) => o.inLane && o.blocked).map((o) => o.name);
    why.push(`Fallback lane used because ${skipped.join(", ") || "lane models"} ${skipped.length === 1 ? "is" : "are"} blocked.`);
  } else if (step.intent === "explore") {
    why.push("Chosen as the cheapest allowed option — exploration is about volume, not polish.");
  }
  return { modelId: model.id, rationale: why.join(" "), options };
}
