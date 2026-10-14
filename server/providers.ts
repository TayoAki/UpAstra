import { getModel, providerOf } from "../shared/catalog";
import type { ModelProvider, ProviderStatus } from "../shared/types";
import { getProvider as getHiggsfield, simulatedProvider, type ProductionProvider } from "./higgsfield";
import { OpenRouterImages } from "./openrouter-images";

// Which production provider runs a model. OpenRouter image models go to
// OpenRouter, everything else visual to Higgsfield; whichever key is missing
// falls back to the free simulator.

let openrouter: ProductionProvider | null = null;
let simulated: ProductionProvider | null = null;

const sim = () => (simulated ??= simulatedProvider(Number(process.env.SIM_LATENCY_MS ?? 700)));
const openrouterLive = () => !!process.env.OPENROUTER_API_KEY;
const higgsfieldLive = () => !!process.env.HIGGSFIELD_API_KEY;

export function providerFor(modelId: string): ProductionProvider {
  const model = getModel(modelId);
  if (model && providerOf(model) === "openrouter") {
    if (!openrouterLive()) return sim();
    return (openrouter ??= new OpenRouterImages(process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1", process.env.OPENROUTER_API_KEY!));
  }
  return getHiggsfield();
}

/** Media providers with live keys, plus the built-in AI. Null when no media provider is live. */
export function connectedProviders(): ModelProvider[] | null {
  const media: ModelProvider[] = [];
  if (openrouterLive()) media.push("openrouter");
  if (higgsfieldLive()) media.push("higgsfield");
  return media.length ? ["builtin", ...media] : null;
}

export function imagesMode(): ProviderStatus["images"] {
  if (openrouterLive() && higgsfieldLive()) return "openrouter+higgsfield";
  if (openrouterLive()) return "openrouter";
  if (higgsfieldLive()) return "higgsfield";
  return "simulated";
}
