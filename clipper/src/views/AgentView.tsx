import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, Loader2, Plus, Send, Square, Trash2, X } from "lucide-react";
import type { AgentRun, AgentStep } from "../../shared/types";
import { api } from "../api";
import { ago } from "../components/ui";
import { go, useApp } from "../store";

type Run = AgentRun & { working: boolean };

const TOOL_LABEL: Record<string, string> = {
  overview: "Looked at your campaigns",
  brief_to_shorts: "Read the brief and started the clips",
  add_campaign: "Added the campaign",
  get_campaign: "Checked the campaign",
  find_moments: "Watched footage for highlights",
  plan_clips: "Wrote clip plans",
  get_clip: "Checked a clip",
  edit_clip: "Edited a clip plan",
  review_clip: "Reviewed a clip plan",
  render_clip: "Started a render",
  wait_for_renders: "Waited for renders",
  caption_video: "Captioned a video",
  get_caption_job: "Checked captions",
  list_social_accounts: "Checked your accounts",
  schedule_clip: "Schedule a post",
  list_schedule: "Checked the schedule",
  cancel_scheduled_post: "Cancel a scheduled post",
  log_post: "Logged a post",
  update_post_metrics: "Updated views",
  list_posts: "Checked posts",
  whats_working: "Checked what's working",
  make_variants: "Wrote A/B variants",
  clone_format: "Started breaking down a reference video",
  list_formats: "Checked your formats",
  get_format: "Read a format",
};

const STARTERS = [
  "Make 3 shorts from this brief: ",
  "Schedule my ready clips, one a day at 6pm on TikTok",
  "What hooks are working best for me?",
  "Caption this video in the Karaoke style: ",
];

/** Light markdown for agent replies: links, **bold** and `code`. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+|\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return (
    <div className="agent-text">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p.length > 60 ? `${p.slice(0, 57)}…` : p}
          </a>
        ) : /^\*\*.+\*\*$/.test(p) ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : /^`.+`$/.test(p) ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

function StepGroup({ steps, pendingId }: { steps: AgentStep[]; pendingId?: string }) {
  const [open, setOpen] = useState(false);
  const done = steps.filter((s) => s.result !== undefined || s.id === pendingId).length;
  return (
    <div className="agent-steps">
      <button className="agent-steps-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </strong>
        {done < steps.length && <Loader2 size={13} className="spin" />}
      </button>
      {(open ? steps : steps.slice(-3)).map((s) => (
        <div key={s.id} className="agent-step">
          {s.id === pendingId ? <AlertTriangle size={14} className="warn-text" /> : s.result === undefined ? <Loader2 size={14} className="spin faint" /> : s.error ? <X size={14} className="neg" /> : <Check size={14} className="pos" />}
          <div style={{ minWidth: 0 }}>
            <div className="small">{TOOL_LABEL[s.tool ?? ""] ?? s.tool}</div>
            {open && s.result && <div className="small faint ellipsis">{s.result}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentView({ id }: { id?: string }) {
  const { state, run: act, busy, toast, refresh } = useApp();
  const [run, setRun] = useState<Run>();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const live = !!run && (run.working || run.status === "running");

  // Load the run, and keep polling while the agent works.
  useEffect(() => {
    if (!id) return setRun(undefined);
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/agent/runs/${id}`).then((x) => (x.ok ? x.json() : Promise.reject(new Error("gone"))));
        if (stop) return;
        setRun(r);
        if (r.working || r.status === "running") setTimeout(tick, 1500);
      } catch {
        if (!stop) setRun(undefined);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id, run?.status === "running" && !!run?.working]);

  // Keep the chat list (and anything the agent changed) in sync.
  useEffect(() => void refresh(), [run?.id, run?.status, run?.working, refresh]);

  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [run?.steps.length, run?.status]);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    const r = await act(() =>
      fetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, runId: id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      }).then(async (x) => {
        const j = await x.json();
        if (!x.ok) throw new Error(j.error ?? "Couldn't reach the agent");
        return j as Run;
      }),
    );
    if (r) {
      setText("");
      setRun(r);
      if (r.id !== id) go(`/agent/${r.id}`);
    }
  };
  const decide = async (approve: boolean) => {
    const r = await act(() => fetch(`/api/agent/runs/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }) }).then((x) => x.json()));
    if (r) setRun(r as Run);
  };
  const stop = async () => {
    const r = await act(() => fetch(`/api/agent/runs/${id}/stop`, { method: "POST" }).then((x) => x.json()));
    if (r) setRun(r as Run);
  };

  // Steps between messages collapse into one group, like a checklist.
  const blocks: ({ kind: "msg"; step: AgentStep } | { kind: "tools"; steps: AgentStep[] })[] = [];
  for (const s of run?.steps ?? []) {
    const last = blocks[blocks.length - 1];
    if (s.kind === "tool") last?.kind === "tools" ? last.steps.push(s) : blocks.push({ kind: "tools", steps: [s] });
    else blocks.push({ kind: "msg", step: s });
  }
  const runs = state?.agentRuns ?? [];
  const off = state?.status.ai !== "live";

  return (
    <div className="agent-layout">
      <aside className="agent-runs">
        <button className="btn sm primary" onClick={() => go("/agent")} style={{ width: "100%" }}>
          <Plus size={14} /> New chat
        </button>
        {runs.map((r) => (
          <button key={r.id} className={`side-item ${r.id === id ? "on" : ""}`} onClick={() => go(`/agent/${r.id}`)}>
            <span className="grow" style={{ minWidth: 0 }}>
              <div className="t ellipsis">{r.title}</div>
              <div className="s">
                {r.pending ? "Needs your OK · " : r.status === "running" ? "Working · " : ""}
                {ago(r.updatedAt)}
              </div>
            </span>
          </button>
        ))}
      </aside>

      <section className="agent-main">
        <div className="agent-scroll">
          {!run ? (
            <div className="agent-empty">
              <Bot size={30} className="faint" />
              <h2 style={{ margin: "8px 0 4px" }}>Clipping Agent</h2>
              <p className="muted" style={{ marginTop: 0, maxWidth: 520 }}>
                Tell it what you want: it reads briefs, writes and renders clips, captions videos, and schedules posts — using the same rules and limits as the rest of the app. Anything it would publish waits for your OK.
              </p>
              <div className="chips" style={{ justifyContent: "center" }}>
                {STARTERS.map((s) => (
                  <button key={s} className="chip" onClick={() => setText(s)}>
                    {s.trim()}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {blocks.map((b, i) =>
                b.kind === "tools" ? (
                  <StepGroup key={i} steps={b.steps} pendingId={run.pending?.stepId} />
                ) : b.step.kind === "user" ? (
                  <div key={b.step.id} className="agent-bubble user">
                    {b.step.text}
                  </div>
                ) : (
                  <div key={b.step.id} className="agent-bubble">
                    <RichText text={b.step.text ?? ""} />
                  </div>
                ),
              )}
              {run.pending && (
                <div className="agent-approve">
                  <strong className="row">
                    <AlertTriangle size={15} className="warn-text" /> {TOOL_LABEL[run.pending.tool] ?? run.pending.tool}?
                  </strong>
                  <pre className="snippet">{JSON.stringify(run.pending.args, null, 2)}</pre>
                  <div className="row">
                    <button className="btn primary sm" disabled={busy} onClick={() => decide(true)}>
                      <Check size={14} /> Approve
                    </button>
                    <button className="btn sm" disabled={busy} onClick={() => decide(false)}>
                      <X size={14} /> Decline
                    </button>
                  </div>
                </div>
              )}
              {live && (
                <p className="small muted row">
                  <Loader2 size={14} className="spin" /> Working…
                </p>
              )}
              {run.error && <p className="small neg">{run.error}</p>}
              <div ref={end} />
            </>
          )}
        </div>

        <div className="agent-composer">
          <textarea
            className="input"
            rows={2}
            placeholder={off ? "The agent needs an AI key on the server" : run?.pending ? "Approve or decline above first…" : "Tell the agent what to do…"}
            value={text}
            disabled={off}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), live || run?.pending ? toast("Wait for the agent, or stop it", true) : void send())}
          />
          {live ? (
            <button className="btn" onClick={stop} title="Stop">
              <Square size={14} /> Stop
            </button>
          ) : (
            <button className="btn primary" disabled={busy || off || !text.trim() || !!run?.pending} onClick={send}>
              <Send size={14} />
            </button>
          )}
          {run && !live && (
            <button className="btn ghost" title="Delete chat" onClick={() => confirm("Delete this chat?") && act(() => api.deleteAgentRun(run.id), "Deleted").then((r) => r && go("/agent"))}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <p className="small faint" style={{ margin: "4px 2px 0" }}>
          The agent can make mistakes and uses your daily AI allowance.
        </p>
      </section>
    </div>
  );
}
