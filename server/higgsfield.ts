import { getModel, stepCost } from "../shared/catalog";

// Production layer. One key, one submit → check → download flow for every
// creative model. The key is read from the server environment only and is
// never sent to the browser.
//
// Live mode targets Higgsfield's platform API. The endpoint paths below are
// isolated in one place so they can be matched to the current API reference
// without touching the rest of the system.

export interface SubmitRequest {
  modelId: string;
  prompt: string;
  units: number;
  aspect?: string;
  durationSec?: number;
  referenceUrls?: string[];
  sourceUrl?: string; // asset to edit / finish
  label: string;
  palette: string[];
  kind: "image" | "video" | "audio";
}

export interface ProviderResult {
  status: "queued" | "running" | "completed" | "failed";
  outputUrl?: string;
  cost?: number;
  error?: string;
}

export interface ProductionProvider {
  mode: "live" | "simulated";
  baseUrl: string;
  submit(req: SubmitRequest): Promise<{ requestId: string }>;
  check(requestId: string): Promise<ProviderResult>;
}

const ENDPOINTS = {
  submit: (modelId: string) => `/v1/models/${encodeURIComponent(modelId)}/generations`,
  status: (id: string) => `/v1/generations/${encodeURIComponent(id)}`,
};

class LiveHiggsfield implements ProductionProvider {
  mode = "live" as const;
  constructor(
    public baseUrl: string,
    private key: string,
  ) {}

  private async call(pathname: string, init?: RequestInit) {
    const res = await fetch(this.baseUrl + pathname, {
      ...init,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Higgsfield ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async submit(req: SubmitRequest) {
    const body = {
      prompt: req.prompt,
      aspect_ratio: req.aspect,
      duration: req.durationSec,
      reference_images: req.referenceUrls,
      input_image: req.sourceUrl,
    };
    const data = await this.call(ENDPOINTS.submit(req.modelId), { method: "POST", body: JSON.stringify(body) });
    const requestId = data.id ?? data.request_id ?? data.job_id;
    if (!requestId) throw new Error("Higgsfield response did not include a request id");
    return { requestId: String(requestId) };
  }

  async check(requestId: string): Promise<ProviderResult> {
    const d = await this.call(ENDPOINTS.status(requestId));
    const raw = String(d.status ?? "").toLowerCase();
    const status: ProviderResult["status"] = ["completed", "succeeded", "success", "done"].includes(raw)
      ? "completed"
      : ["failed", "error", "cancelled", "canceled", "nsfw"].includes(raw)
        ? "failed"
        : raw === "queued" || raw === "pending"
          ? "queued"
          : "running";
    const outputUrl = d.output?.url ?? d.outputs?.[0]?.url ?? d.result?.url ?? d.url;
    const cost = typeof d.cost === "number" ? d.cost : typeof d.credits_cost === "number" ? d.credits_cost : undefined;
    return { status, outputUrl, cost, error: d.error ?? d.message };
  }
}

// ---------------------------------------------------------------------------
// Simulated production: deterministic, free, and fast. Renders an SVG proof of
// the requested asset so the full intake → QA → delivery loop is testable
// without spending credits.

interface SimJob {
  req: SubmitRequest;
  readyAt: number;
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

class SimulatedHiggsfield implements ProductionProvider {
  mode = "simulated" as const;
  baseUrl = "simulated://higgsfield";
  private jobs = new Map<string, SimJob>();
  private seq = 0;
  constructor(private latencyMs: number) {}

  async submit(req: SubmitRequest) {
    const requestId = `sim_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    this.jobs.set(requestId, { req, readyAt: Date.now() + this.latencyMs });
    return { requestId };
  }

  async check(requestId: string): Promise<ProviderResult> {
    const job = this.jobs.get(requestId);
    if (!job) return { status: "failed", error: "unknown request" };
    if (Date.now() < job.readyAt) return { status: "running" };
    const model = getModel(job.req.modelId);
    const list = model ? stepCost(model, job.req.units) : 0;
    // Actual charges drift a little from list price, like real billing does.
    const drift = 0.92 + (hash(requestId) % 13) / 100;
    return { status: "completed", outputUrl: renderProof(job.req, requestId), cost: Math.round(list * drift * 1000) / 1000 };
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function renderProof(req: SubmitRequest, seed: string): string {
  const [aw, ah] = (req.aspect ?? "1:1").split(":").map(Number);
  const w = 480;
  const h = Math.round((w * (ah || 1)) / (aw || 1));
  const n = hash(seed);
  const palette = req.palette.length ? req.palette : ["#1f2937", "#f59e0b", "#fef3c7"];
  const c1 = palette[0];
  const c2 = palette[1 % palette.length];
  const c3 = palette[2 % palette.length];
  const cx = w * (0.35 + (n % 30) / 100);
  const cy = h * 0.55;
  const r = Math.min(w, h) * (0.16 + ((n >> 5) % 10) / 100);
  const model = getModel(req.modelId)?.name ?? req.modelId;
  const isVideo = req.kind === "video";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="${(n % 2) as number}" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<radialGradient id="l" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect width="${w}" height="${h}" fill="url(#l)"/>
<ellipse cx="${cx}" cy="${cy + r * 1.35}" rx="${r * 1.2}" ry="${r * 0.18}" fill="#000" opacity=".22"/>
<rect x="${cx - r * 0.45}" y="${cy - r * 1.1}" width="${r * 0.9}" height="${r * 2.4}" rx="${r * 0.22}" fill="${c3}" opacity=".95"/>
<rect x="${cx - r * 0.45}" y="${cy - r * 0.1}" width="${r * 0.9}" height="${r * 0.6}" fill="${c1}" opacity=".85"/>
<rect x="${cx - r * 0.18}" y="${cy - r * 1.45}" width="${r * 0.36}" height="${r * 0.4}" rx="${r * 0.06}" fill="${c1}"/>
<circle cx="${w * 0.78}" cy="${h * 0.22}" r="${r * 0.7}" fill="${c3}" opacity=".25"/>
${isVideo ? `<circle cx="${w / 2}" cy="${h / 2}" r="34" fill="#000" opacity=".45"/><path d="M${w / 2 - 10} ${h / 2 - 16} L${w / 2 + 18} ${h / 2} L${w / 2 - 10} ${h / 2 + 16} Z" fill="#fff"/>` : ""}
<rect x="0" y="${h - 58}" width="${w}" height="58" fill="#000" opacity=".38"/>
<text x="16" y="${h - 34}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" fill="#fff">${esc(req.label.slice(0, 48))}</text>
<text x="16" y="${h - 14}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="12" fill="#fff" opacity=".8">${esc(model)} · ${esc(req.aspect ?? "")}${isVideo && req.durationSec ? ` · ${req.durationSec}s` : ""} · simulated proof</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

let provider: ProductionProvider | null = null;

export function getProvider(): ProductionProvider {
  if (provider) return provider;
  const key = process.env.HIGGSFIELD_API_KEY;
  provider = key
    ? new LiveHiggsfield(process.env.HIGGSFIELD_BASE_URL ?? "https://platform.higgsfield.ai", key)
    : new SimulatedHiggsfield(Number(process.env.SIM_LATENCY_MS ?? 700));
  return provider;
}

/** Seeding and tests always use a free, instant simulator. */
export function simulatedProvider(latencyMs = 0): ProductionProvider {
  return new SimulatedHiggsfield(latencyMs);
}
