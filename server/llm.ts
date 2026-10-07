// The one place the app talks to a language model.
//
// OpenRouter is the default built-in AI (OPENROUTER_API_KEY). Any
// OpenAI-compatible endpoint also works (OPENAI_API_KEY + OPENAI_BASE_URL).
// Intake, QA, copywriting and proposal drafting all call chatJSON(), so
// swapping providers or adding custom routing only touches this file.

export type LLMRole = "astra" | "copy-fast" | "copy-pro" | "copy-edit" | "proposal";

const ROLE_ENV: Record<LLMRole, string> = {
  astra: "ASTRA_MODEL",
  "copy-fast": "COPY_FAST_MODEL",
  "copy-pro": "COPY_PRO_MODEL",
  "copy-edit": "COPY_EDIT_MODEL",
  proposal: "PROPOSAL_MODEL",
};

interface Provider {
  name: "openrouter" | "openai";
  baseUrl: string;
  key: string;
  headers: Record<string, string>;
  defaultModel: string;
}

function provider(): Provider | null {
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      key: process.env.OPENROUTER_API_KEY,
      // Attribution headers OpenRouter uses for its app rankings (optional).
      headers: { "HTTP-Referer": process.env.APP_URL ?? "https://studio-operator.app", "X-Title": "Studio Operator" },
      // OpenRouter's auto router picks a model per request; set ASTRA_MODEL etc. to pin one.
      defaultModel: "openrouter/auto",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai", baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", key: process.env.OPENAI_API_KEY, headers: {}, defaultModel: "astra" };
  }
  return null;
}

export const llmConfigured = () => provider() !== null;
export const llmProviderName = () => provider()?.name ?? "none";

/** Model id for a role: role-specific env → ASTRA_MODEL → provider default. */
export function modelFor(role: LLMRole): string {
  return process.env[ROLE_ENV[role]] || process.env.ASTRA_MODEL || provider()?.defaultModel || "simulated";
}

export interface ChatResult<T> {
  json: T;
  model: string;
  tokens: number;
  /** USD, when the provider reports it (OpenRouter usage accounting). */
  cost?: number;
}

/** Pull the first JSON object out of a reply, tolerating code fences and prose. */
export function parseJSON<T>(content: string): T {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model did not return JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export async function chatJSON<T>(opts: { role: LLMRole; system: string; user: unknown; images?: string[]; maxTokens?: number }): Promise<ChatResult<T>> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured (set OPENROUTER_API_KEY)");
  const model = modelFor(opts.role);
  const content: unknown[] = [{ type: "text", text: typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user, null, 1) }];
  for (const url of opts.images ?? []) if (/^https?:/.test(url)) content.push({ type: "image_url", image_url: { url } });

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: `${opts.system}\nRespond with a single JSON object only.` },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (p.name === "openrouter") body.usage = { include: true };

  let res = await post(p, body);
  // Some routed models reject response_format; retry once without it.
  if (res.status === 400 && /response_format|json_object/i.test(res.text)) {
    delete body.response_format;
    res = await post(p, body);
  }
  if (!res.ok) throw new Error(`${p.name} ${res.status}: ${res.text.slice(0, 300)}`);
  const data = JSON.parse(res.text);
  const msg = data.choices?.[0]?.message?.content ?? "";
  return {
    json: parseJSON<T>(typeof msg === "string" ? msg : JSON.stringify(msg)),
    model: data.model ?? model,
    tokens: data.usage?.total_tokens ?? 0,
    cost: typeof data.usage?.cost === "number" ? data.usage.cost : undefined,
  };
}

async function post(p: Provider, body: unknown) {
  const r = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
