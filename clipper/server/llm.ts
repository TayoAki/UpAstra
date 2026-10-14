// The one place the app talks to a language model (OpenRouter, or any
// OpenAI-compatible endpoint). Without a key, callers fall back to rules.

export type AIRole = "extract" | "script";

const DEFAULTS: Record<AIRole, { env: string; model: string }> = {
  extract: { env: "EXTRACT_MODEL", model: "anthropic/claude-haiku-5.5" },
  script: { env: "SCRIPT_MODEL", model: "anthropic/claude-sonnet-5.5" },
};

let forcedOff = false;
/** Tests and demos: never call a model. */
export const setAISimulated = (off: boolean) => (forcedOff = off);

function provider() {
  if (forcedOff) return null;
  if (process.env.OPENROUTER_API_KEY)
    return {
      url: `${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      key: process.env.OPENROUTER_API_KEY,
      headers: { "HTTP-Referer": process.env.APP_URL ?? "https://clip-operator.app", "X-Title": "Clip Operator" } as Record<string, string>,
      openrouter: true,
    };
  if (process.env.OPENAI_API_KEY)
    return { url: `${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, key: process.env.OPENAI_API_KEY, headers: {} as Record<string, string>, openrouter: false };
  return null;
}

export const aiLive = () => provider() !== null;
export const modelFor = (role: AIRole) => process.env[DEFAULTS[role].env] || DEFAULTS[role].model;

export function parseJSON<T>(content: string): T {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : content;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model did not return JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export interface AIResult<T> {
  json: T;
  model: string;
  cost: number;
}

export async function chatJSON<T>(role: AIRole, system: string, user: unknown, maxTokens = 4000): Promise<AIResult<T>> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const model = modelFor(role);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: `${system}\nRespond with a single JSON object only.` },
      { role: "user", content: typeof user === "string" ? user : JSON.stringify(user, null, 1) },
    ],
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
  };
  if (p.openrouter) body.usage = { include: true };
  const post = () =>
    fetch(p.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }));
  let res = await post();
  if (res.status === 400 && /response_format|json_object/i.test(res.text)) {
    delete body.response_format;
    res = await post();
  }
  if (!res.ok) throw new Error(`AI ${res.status}: ${res.text.slice(0, 300)}`);
  const data = JSON.parse(res.text);
  const msg = data.choices?.[0]?.message?.content ?? "";
  return { json: parseJSON<T>(typeof msg === "string" ? msg : JSON.stringify(msg)), model: data.model ?? model, cost: typeof data.usage?.cost === "number" ? data.usage.cost : 0 };
}
