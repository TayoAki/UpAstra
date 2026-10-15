// The one place the app talks to a language model (OpenRouter, or any
// OpenAI-compatible endpoint). Without a key, callers fall back to rules.

export type AIRole = "extract" | "script" | "moments" | "voice";

const DEFAULTS: Record<AIRole, { env: string; model: string }> = {
  extract: { env: "EXTRACT_MODEL", model: "anthropic/claude-haiku-5.5" },
  script: { env: "SCRIPT_MODEL", model: "anthropic/claude-sonnet-5.5" },
  // Watches footage: Gemini takes video input through OpenRouter.
  moments: { env: "MOMENT_MODEL", model: "google/gemini-3.5-flash-lite" },
  // Speaks voiceovers: an audio-output model on OpenRouter.
  voice: { env: "VOICE_MODEL", model: "openai/gpt-audio-mini" },
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

/** The model behind the editor's AI chat. */
export const editorModel = () => process.env.EDITOR_MODEL || DEFAULTS.script.model;

/**
 * Forward an OpenAI-style chat request from the editor to the provider with the
 * server's key. The model is pinned (the editor can't pick an expensive one),
 * output is capped, and the response (streamed or not) is passed through as is.
 */
type Schema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * Some providers (Anthropic among them) reject tool parameter schemas with a
 * top-level oneOf/anyOf/allOf. Flatten those into one object: every
 * alternative's fields, required only where all alternatives require them.
 */
export function flattenToolSchema(schema: unknown): unknown {
  const s = schema as Schema | undefined;
  if (!s || typeof s !== "object") return schema;
  const all = (s.allOf as Schema[] | undefined) ?? [];
  const alts = [...((s.oneOf as Schema[] | undefined) ?? []), ...((s.anyOf as Schema[] | undefined) ?? [])];
  if (!all.length && !alts.length) return schema;
  const { oneOf: _o, anyOf: _a, allOf: _l, ...base } = s;
  const properties: Record<string, unknown> = { ...(s.properties ?? {}) };
  for (const v of [...all, ...alts]) Object.assign(properties, v.properties ?? {});
  const required = new Set([...(s.required ?? []), ...all.flatMap((v) => v.required ?? [])]);
  if (alts.length) {
    const shared = alts.map((v) => new Set(v.required ?? [])).reduce((x, y) => new Set([...x].filter((k) => y.has(k))));
    for (const k of shared) required.add(k);
  }
  return { ...base, type: "object", properties, ...(required.size ? { required: [...required] } : {}) };
}

const flattenTools = (tools: unknown) =>
  Array.isArray(tools)
    ? tools.map((t) => (t?.function?.parameters ? { ...t, function: { ...t.function, parameters: flattenToolSchema(t.function.parameters) } } : t))
    : tools;

export async function forwardChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const maxTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens) || 4096, 8192);
  const { max_completion_tokens: _drop, ...raw } = body;
  const rest = { ...raw, ...(raw.tools ? { tools: flattenTools(raw.tools) } : {}) };
  return fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
    body: JSON.stringify({ ...rest, model: editorModel(), max_tokens: maxTokens }),
    signal,
  });
}
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

/** OpenRouter only: video input and audio output aren't part of the plain OpenAI API. */
export const mediaLive = () => !forcedOff && !!process.env.OPENROUTER_API_KEY;

export async function chatJSON<T>(role: AIRole, system: string, user: unknown, maxTokens = 4000, media: unknown[] = []): Promise<AIResult<T>> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const model = modelFor(role);
  const text = typeof user === "string" ? user : JSON.stringify(user, null, 1);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: `${system}\nRespond with a single JSON object only.` },
      { role: "user", content: media.length ? [{ type: "text", text }, ...media] : text },
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
  if (data.choices?.[0]?.finish_reason === "length") console.warn(`[ai] ${role} reply hit max_tokens (${maxTokens})`);
  return { json: parseJSON<T>(typeof msg === "string" ? msg : JSON.stringify(msg)), model: data.model ?? model, cost: typeof data.usage?.cost === "number" ? data.usage.cost : 0 };
}

/** Read a script aloud. Returns 24 kHz mono 16-bit PCM and the provider's cost. */
export async function speak(script: string, voice: string): Promise<{ pcm: Buffer; cost: number; transcript: string }> {
  if (!mediaLive()) throw new Error("Voiceover needs OPENROUTER_API_KEY");
  const res = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Clip Operator" },
    body: JSON.stringify({
      model: modelFor("voice"),
      modalities: ["text", "audio"],
      audio: { voice, format: "pcm16" },
      stream: true,
      usage: { include: true },
      messages: [
        { role: "system", content: "You are a voiceover artist for short-form videos. Read the user's script aloud exactly as written, word for word, with energetic, natural delivery. Never add, skip or change words." },
        { role: "user", content: script },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok || !res.body) throw new Error(`Voice ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const chunks: Buffer[] = [];
  let transcript = "";
  let cost = 0;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (typeof d.usage?.cost === "number") cost = d.usage.cost;
        for (const c of d.choices ?? []) {
          const a = c.delta?.audio;
          if (a?.data) chunks.push(Buffer.from(a.data, "base64"));
          if (a?.transcript) transcript += a.transcript;
        }
      } catch {
        /* keep-alive comments and partial lines */
      }
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < 4800) throw new Error("The voice model returned no audio");
  return { pcm, cost, transcript };
}
