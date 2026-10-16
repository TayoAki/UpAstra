import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentRun, AgentStep } from "../shared/types";
import { getDoc, HttpError, newId, now, runInWorkspace, save, tenantLoadHooks } from "./db";
import { aiLive, flattenToolSchema, forwardChatAs, spendAI } from "./llm";
import { createMcpServer, httpApi } from "./mcp";
import { alert, isUserError } from "./alerts";

// The Clipping Agent: a chat in the app that runs the whole loop — briefs,
// clip plans, renders, captions, scheduling — with the same tools external
// agents get over MCP (connected in memory), acting as the signed-in user.
// Anything that publishes waits for the user's OK.

/** Tools that act publicly on the user's social accounts: always ask first. */
export const NEEDS_APPROVAL = new Set(["schedule_clip", "cancel_scheduled_post"]);
const MAX_STEPS = 30;
const RESULT_CHARS = 12_000;

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** Conversation memory per run (kept on the server, not sent to the browser). */
const transcripts = new Map<string, Msg[]>();
const running = new Map<string, AbortController>();

const system = (tz: string) => `You are the Clipping Agent inside UGCMediaClips, a tool for "clippers" who earn money posting short videos (TikTok, Reels, Shorts) for paid clipping campaigns.
You act for the signed-in user through your tools. Today is ${new Date().toISOString()} (UTC); the user's time zone is ${tz}.

How to work:
- From a brief (link or text): add_campaign or brief_to_shorts, then plan_clips / review_clip / render_clip, then wait_for_renders for video links.
- Plans are checked against the brief in code. Never approve a plan that fails a rule without telling the user which rule and why.
- Captions: renders are captioned automatically in the workspace's style; use caption_video for other videos.
- Publishing: list_social_accounts, then schedule_clip. Posting is public: the app asks the user to approve each schedule_clip — propose the accounts and times clearly. Convert times the user gives in their time zone to ISO 8601 with offset.
- Use whats_working to lean on hooks and formats that performed. To A/B test openings, make_variants on a clip.
- To copy a viral video's structure: clone_format (a direct video link), wait for get_format to be ready, then plan_clips with formatId.
- Clips can carry overlays timed to words (comment bubbles, emoji, pop-up words, tier lists) via edit_clip; cues must be exact words from the voiceover.
- Don't invent payouts, views or links; report what the tools return. Keep replies short: what you did, links, and what needs the user.`;

/** After a restart the full transcript is gone: continue from what the user saw. */
function rebuild(run: AgentRun, tz: string): Msg[] {
  const msgs: Msg[] = [{ role: "system", content: system(tz) }];
  for (const s of run.steps) {
    if (s.kind === "user") msgs.push({ role: "user", content: s.text ?? "" });
    else if (s.kind === "assistant") msgs.push({ role: "assistant", content: s.text ?? "" });
    else msgs.push({ role: "assistant", content: `(Earlier I called ${s.tool}: ${s.result ?? "no result"})` });
  }
  return msgs;
}

// Runs don't survive a restart: say so rather than spinning forever.
tenantLoadHooks.push((_ws, doc) => {
  for (const r of doc.agentRuns ?? [])
    if (r.status === "running" || r.status === "waiting") Object.assign(r, { status: "stopped", pending: undefined, error: "Interrupted by a server restart — send a message to continue." });
});

const truncate = (s: string) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n…(truncated)` : s);
const summary = (s: string) => s.replace(/\s+/g, " ").slice(0, 280);

function findRun(id: string) {
  const r = getDoc().agentRuns?.find((x) => x.id === id);
  if (!r) throw new HttpError(404, "Run not found");
  return r;
}

function addStep(run: AgentRun, step: Omit<AgentStep, "id" | "at">): AgentStep {
  const s = { id: newId("step"), at: now(), ...step };
  run.steps.push(s);
  run.updatedAt = now();
  save();
  return s;
}

export interface AgentContext {
  workspaceId: string;
  /** Loopback base URL and the user's session cookie: tools call the API as them. */
  baseUrl: string;
  cookie: string;
  timezone: string;
}

/** Start a new run or continue one with a user message. Returns immediately; the loop runs in the background. */
export function sendToAgent(ctx: AgentContext, message: string, runId?: string): AgentRun {
  if (!aiLive()) throw new HttpError(503, "The agent needs an AI key on the server");
  const doc = getDoc();
  if ([...running.keys()].some((id) => doc.agentRuns?.some((r) => r.id === id))) throw new HttpError(409, "The agent is already working — wait for it or stop it");
  let run: AgentRun;
  if (runId) {
    run = findRun(runId);
    if (run.status === "waiting") throw new HttpError(409, "Approve or decline the pending action first");
  } else {
    const at = now();
    run = { id: newId("run"), title: message.replace(/\s+/g, " ").slice(0, 80), status: "running", steps: [], cost: 0, createdAt: at, updatedAt: at };
    doc.agentRuns = [run, ...(doc.agentRuns ?? [])].slice(0, 30);
  }
  run.status = "running";
  run.error = undefined;
  addStep(run, { kind: "user", text: message.slice(0, 8000) });
  const msgs = transcripts.get(run.id) ?? rebuild(run, ctx.timezone);
  msgs.push({ role: "user", content: message.slice(0, 8000) });
  transcripts.set(run.id, msgs);
  void loop(ctx, run.id);
  return run;
}

/** The user's answer to a pending publishing action. */
export function resolvePending(ctx: AgentContext, runId: string, approve: boolean): AgentRun {
  const run = findRun(runId);
  if (run.status !== "waiting" || !run.pending) throw new HttpError(409, "Nothing is waiting for approval");
  if (running.has(run.id)) throw new HttpError(409, "The agent is already working");
  run.status = "running";
  save();
  void loop(ctx, run.id, approve ? "approve" : "decline");
  return run;
}

export function stopAgent(runId: string): AgentRun {
  const run = findRun(runId);
  running.get(run.id)?.abort();
  if (run.status === "running" || run.status === "waiting") {
    run.status = "stopped";
    if (run.pending) {
      const msgs = transcripts.get(run.id);
      msgs?.push({ role: "tool", tool_call_id: run.pending.callId, content: "Stopped by the user before this ran." });
      run.pending = undefined;
    }
    run.updatedAt = now();
    save();
  }
  return run;
}

async function loop(ctx: AgentContext, runId: string, resume?: "approve" | "decline") {
  const ctrl = new AbortController();
  running.set(runId, ctrl);
  const client = new Client({ name: "clipping-agent", version: "1" });
  await runInWorkspace(ctx.workspaceId, undefined, async () => {
    const run = findRun(runId);
    const msgs = transcripts.get(runId)!;
    try {
      // The MCP server, in memory, calling this API as the user (marked as the agent).
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer(httpApi(ctx.baseUrl, "", { Cookie: ctx.cookie, "X-Clip-Agent": "in-app" }, true));
      await server.connect(a);
      await client.connect(b);
      const tools = (await client.listTools()).tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: flattenToolSchema(t.inputSchema) as Record<string, unknown> } }));

      const exec = async (call: ToolCall, step: AgentStep) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* empty */
        }
        const r = await client.callTool({ name: call.function.name, arguments: args }, undefined, { timeout: 10 * 60_000, signal: ctrl.signal });
        const text = ((r.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
        step.result = summary(text);
        step.error = !!r.isError;
        msgs.push({ role: "tool", tool_call_id: call.id, content: truncate(text) });
        save();
      };

      if (resume && run.pending) {
        const p = run.pending;
        const step = run.steps.find((s) => s.id === p.stepId)!;
        run.pending = undefined;
        if (resume === "approve") await exec({ id: p.callId, type: "function", function: { name: p.tool, arguments: JSON.stringify(p.args) } }, step);
        else {
          step.result = "Declined by the user.";
          step.error = true;
          msgs.push({ role: "tool", tool_call_id: p.callId, content: "The user declined this action. Don't retry it unless they ask." });
        }
      }

      for (let n = 0; n < MAX_STEPS && !ctrl.signal.aborted; n++) {
        spendAI(ctx.workspaceId, 1);
        const reply = await forwardChatAs("agent", { messages: msgs, tools, tool_choice: "auto", max_tokens: 4096 }, ctrl.signal);
        run.cost = Math.round((run.cost + reply.cost) * 10000) / 10000;
        run.model = reply.model;
        const m = reply.message;
        msgs.push({ role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls?.length ? m.tool_calls : undefined });
        if (m.content?.trim()) addStep(run, { kind: "assistant", text: m.content.trim() });
        if (!m.tool_calls?.length) {
          run.status = "done";
          break;
        }
        for (const call of m.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* shown as {} */
          }
          const step = addStep(run, { kind: "tool", tool: call.function.name, args });
          if (NEEDS_APPROVAL.has(call.function.name)) {
            // Pause here; later calls in this batch are skipped and the model is told.
            run.pending = { stepId: step.id, tool: call.function.name, args, callId: call.id };
            for (const rest of m.tool_calls.slice(m.tool_calls.indexOf(call) + 1)) msgs.push({ role: "tool", tool_call_id: rest.id, content: "Not run: waiting for the user to approve an earlier action." });
            run.status = "waiting";
            break;
          }
          await exec(call, step);
        }
        if (run.status === "waiting") break;
      }
      if (run.status === "running") {
        run.status = ctrl.signal.aborted ? "stopped" : "done";
        if (!ctrl.signal.aborted) addStep(run, { kind: "assistant", text: "I stopped after many steps — tell me how to continue." });
      }
    } catch (err) {
      if (ctrl.signal.aborted) run.status = "stopped";
      else {
        run.status = "failed";
        run.error = (err as Error).message.slice(0, 300);
        console.error(`[agent] ${runId} failed:`, run.error);
        if (!isUserError(run.error)) alert("agent run failed", run.error, `workspace ${ctx.workspaceId} · run ${runId}`);
      }
    } finally {
      run.updatedAt = now();
      save();
      running.delete(runId);
      await client.close().catch(() => undefined);
    }
  });
}

export const isRunning = (runId: string) => running.has(runId);
