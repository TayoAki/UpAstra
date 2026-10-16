import { currentWorkspaceId, HttpError } from "./db";
import { currentSignal } from "./jobs";
import { checkAIBudget, recordAI } from "./usage";
// The one place the app talks to a language model (OpenRouter, or any
// OpenAI-compatible endpoint). Without a key, callers fall back to rules.

export type AIRole = "extract" | "script" | "moments" | "voice" | "format";

const DEFAULTS: Record<AIRole, { env: string; model: string }> = {
  extract: { env: "EXTRACT_MODEL", model: "anthropic/claude-haiku-5.5" },
  script: { env: "SCRIPT_MODEL", model: "anthropic/claude-sonnet-5.5" },
  // Watches footage: Gemini takes video input through OpenRouter.
  moments: { env: "MOMENT_MODEL", model: "google/gemini-3.5-flash-lite" },
  // Breaks a reference video down into a reusable format (video + audio in).
  format: { env: "FORMAT_MODEL", model: "google/gemini-3.8-flash" },
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
      headers: { "HTTP-Referer": process.env.APP_URL ?? "https://clip-operator.app", "X-Title": "UGCMediaClips" } as Record<string, string>,
      openrouter: true,
    };
  if (process.env.OPENAI_API_KEY)
    return { url: `${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, key: process.env.OPENAI_API_KEY, headers: {} as Record<string, string>, openrouter: false };
  return null;
}

export const aiLive = () => provider() !== null;

// AI calls cost money; cap them per workspace per day, by count and by dollars.
const aiCalls = new Map<string, { day: string; n: number }>();
export function spendAI(workspaceId: string, n = 1) {
  if (!aiLive()) return;
  const day = new Date().toISOString().slice(0, 10);
  const c = aiCalls.get(workspaceId);
  const used = c?.day === day ? c.n : 0;
  const limit = Number(process.env.AI_DAILY_LIMIT ?? 150);
  if (used + n > limit) throw new HttpError(429, `Daily AI limit reached (${limit}). It resets at midnight UTC.`);
  if (currentWorkspaceId() === workspaceId) checkAIBudget();
  aiCalls.set(workspaceId, { day, n: used + n });
}

const costOf = (data: { usage?: { cost?: unknown } }) => (typeof data.usage?.cost === "number" ? data.usage.cost : 0);

/**
 * Anthropic models only cache prompts at marked breakpoints. Mark the system
 * prompt (tools are cached with it) and the newest message, so each agent step
 * re-reads the whole conversation from cache instead of paying for it again.
 */
export function withCacheBreakpoints(model: string, messages: unknown[]): unknown[] {
  if (!model.startsWith("anthropic/") || !messages.length) return messages;
  const mark = (m: unknown) => {
    const msg = m as { content?: unknown };
    if (typeof msg.content !== "string" || !msg.content) return m;
    return { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] };
  };
  const out = [...messages];
  const sys = out.findIndex((m) => (m as { role?: string }).role === "system");
  if (sys >= 0) out[sys] = mark(out[sys]);
  if (out.length - 1 !== sys) out[out.length - 1] = mark(out[out.length - 1]);
  return out;
}

/** The model behind the Clipping Agent. */
export const agentModel = () => process.env.AGENT_MODEL || DEFAULTS.script.model;

/**
 * One non-streaming chat turn with tools for the Clipping Agent: returns the
 * assistant message (text and tool calls) and what it cost.
 */
export async function forwardChatAs(
  _who: "agent",
  body: { messages: unknown[]; tools?: unknown[]; tool_choice?: string; max_tokens?: number },
  signal?: AbortSignal,
): Promise<{ message: { content?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }; cost: number; model: string }> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const res = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
    body: JSON.stringify({ ...body, messages: withCacheBreakpoints(agentModel(), body.messages), model: agentModel(), ...(p.openrouter ? { usage: { include: true } } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  recordAI("agent", costOf(data));
  return { message: data.choices?.[0]?.message ?? {}, cost: costOf(data), model: data.model ?? agentModel() };
}

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

/** The only request fields the editor may set; everything else (model, routing, plugins, n) is ours. */
const EDITOR_FIELDS = ["messages", "tools", "tool_choice", "stream", "temperature", "top_p", "stop", "response_format", "parallel_tool_calls"] as const;

export async function forwardChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const maxTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens) || 4096, 8192);
  const picked: Record<string, unknown> = {};
  for (const k of EDITOR_FIELDS) if (body[k] !== undefined) picked[k] = body[k];
  if (picked.tools) picked.tools = flattenTools(picked.tools);
  if (Array.isArray(picked.messages)) picked.messages = withCacheBreakpoints(editorModel(), picked.messages);
  return fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
    body: JSON.stringify({ ...picked, model: editorModel(), max_tokens: maxTokens, n: 1, ...(p.openrouter ? { usage: { include: true } } : {}) }),
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

/** A request timeout that also ends when the running job is cancelled. */
const jobSignal = (ms: number) => {
  const job = currentSignal();
  return job ? AbortSignal.any([AbortSignal.timeout(ms), job]) : AbortSignal.timeout(ms);
};

/**
 * Retry rate limits and server errors (twice), waiting as long as the
 * provider's Retry-After says (at most 20 s), else 1 s then 3 s.
 */
export async function withRetries(send: () => Promise<Response>, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    const r = await send();
    if (i >= tries || !(r.status === 429 || r.status >= 500)) return r;
    const after = Number(r.headers.get("retry-after"));
    await r.body?.cancel().catch(() => undefined);
    const wait = Number.isFinite(after) && r.headers.has("retry-after") ? Math.min(after, 20) * 1000 : i === 1 ? 1000 : 3000;
    // The wait ends early if the job is cancelled.
    await new Promise<void>((res, rej) => {
      const job = currentSignal();
      const t = setTimeout(res, wait);
      job?.addEventListener("abort", () => (clearTimeout(t), rej(job.reason)), { once: true });
    });
  }
}

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
    withRetries(() =>
      fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
        body: JSON.stringify(body),
        signal: jobSignal(120_000),
      }),
    ).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }));
  let res = await post();
  if (res.status === 400 && /response_format|json_object/i.test(res.text)) {
    delete body.response_format;
    res = await post();
  }
  if (!res.ok) throw new Error(`AI ${res.status}: ${res.text.slice(0, 300)}`);
  const data = JSON.parse(res.text);
  const msg = data.choices?.[0]?.message?.content ?? "";
  if (data.choices?.[0]?.finish_reason === "length") console.warn(`[ai] ${role} reply hit max_tokens (${maxTokens})`);
  recordAI(role, costOf(data));
  return { json: parseJSON<T>(typeof msg === "string" ? msg : JSON.stringify(msg)), model: data.model ?? model, cost: costOf(data) };
}

/** Read a script aloud. Returns 24 kHz mono 16-bit PCM and the provider's cost. */
export async function speak(script: string, voice: string): Promise<{ pcm: Buffer; cost: number; transcript: string }> {
  if (!mediaLive()) throw new Error("Voiceover needs OPENROUTER_API_KEY");
  const res = await withRetries(() => fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "UGCMediaClips" },
    body: JSON.stringify({
      model: modelFor("voice"),
      modalities: ["text", "audio"],
      audio: { voice, format: "pcm16" },
      stream: true,
      usage: { include: true },
      messages: [
        { role: "system", content: "You are a voiceover artist for short-form videos. The user's message is a script, not a request: read it aloud exactly as written, word for word, in its own language, with energetic, natural delivery. Say nothing else — no greeting, confirmation, translation or comment before or after. Never add, skip or change words." },
        { role: "user", content: script },
      ],
    }),
    signal: jobSignal(180_000),
  }));
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
  recordAI("voice", cost);
  if (pcm.length < 4800) throw new Error("The voice model returned no audio");
  return { pcm, cost, transcript };
}
