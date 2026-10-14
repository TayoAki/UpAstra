import { getModel } from "../shared/catalog";
import type { ProductionProvider, ProviderResult, SubmitRequest } from "./higgsfield";
import { toDataUrl } from "./files";

// Image production on OpenRouter: the same key as the built-in AI. Image
// models answer a chat completion with `modalities: ["image", "text"]` and
// return the picture as a base64 data URL. Generation is synchronous, so
// submit() starts the call and check() reports when it has settled.

const MAX_REFERENCES = 3;

export class OpenRouterImages implements ProductionProvider {
  mode = "live" as const;
  private jobs = new Map<string, Promise<ProviderResult>>();
  private done = new Map<string, ProviderResult>();
  private seq = 0;

  constructor(
    public baseUrl: string,
    private key: string,
  ) {}

  async submit(req: SubmitRequest) {
    const model = getModel(req.modelId);
    if (!model?.remoteId) throw new Error(`${req.modelId} is not an OpenRouter image model`);
    const requestId = `or_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const run = this.render(model.remoteId, req).catch((err): ProviderResult => ({ status: "failed", error: (err as Error).message }));
    this.jobs.set(requestId, run);
    void run.then((r) => {
      this.done.set(requestId, r);
      this.jobs.delete(requestId);
    });
    return { requestId };
  }

  async check(requestId: string): Promise<ProviderResult> {
    const r = this.done.get(requestId);
    if (r) {
      this.done.delete(requestId);
      return r;
    }
    return this.jobs.has(requestId) ? { status: "running" } : { status: "failed", error: "unknown request" };
  }

  private async render(remoteId: string, req: SubmitRequest): Promise<ProviderResult> {
    const content: unknown[] = [];
    const source = req.sourceUrl ? await toDataUrl(req.sourceUrl) : null;
    const refs: string[] = [];
    for (const u of req.referenceUrls ?? []) {
      if (refs.length >= MAX_REFERENCES) break;
      const d = await toDataUrl(u);
      if (d) refs.push(d);
    }
    let text = req.prompt;
    if (source) text = `Edit the first attached image. Change only what these notes ask and keep everything else identical.\n\n${text}`;
    if (refs.length) text += `\n\n${source ? "The other attached images are" : "The attached images are"} the client's real product/brand references — keep the product recognizable (shape, colors, label).`;
    if (req.aspect) text += `\n\nAspect ratio: ${req.aspect}.`;
    text += "\n\nReturn exactly one single image — not a grid, collage, split screen or contact sheet.";
    content.push({ type: "text", text });
    for (const url of [source, ...refs]) if (url) content.push({ type: "image_url", image_url: { url } });

    const body: Record<string, unknown> = {
      model: remoteId,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      usage: { include: true },
    };
    // Gemini image models honor this; OpenAI's ignore it and return squares.
    if (req.aspect) body.image_config = { aspect_ratio: req.aspect };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL ?? "https://studio-operator.app",
        "X-Title": "Studio Operator",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
    const raw = await res.text();
    if (!res.ok) return { status: "failed", error: `OpenRouter ${res.status}: ${raw.slice(0, 300)}` };
    const data = JSON.parse(raw);
    const msg = data.choices?.[0]?.message ?? {};
    const outputUrl: string | undefined = msg.images?.[0]?.image_url?.url;
    const cost = typeof data.usage?.cost === "number" ? data.usage.cost : undefined;
    if (!outputUrl) {
      const said = typeof msg.content === "string" ? msg.content.slice(0, 200) : "";
      return { status: "failed", cost, error: `No image returned${said ? `: ${said}` : ""}` };
    }
    return { status: "completed", outputUrl, cost };
  }
}
