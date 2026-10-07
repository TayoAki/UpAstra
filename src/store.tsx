import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { FirmStats } from "../shared/types";
import { api, getWorkspaceId, setWorkspaceId, type Bootstrap, type JobSummary, type Me } from "./api";
import { AuthView } from "./views/Auth";

// ---------------------------------------------------------------------------
// Session: who is signed in, and which workspace they're in.

interface SessionState {
  me: Me;
  workspaceId: string;
  switchWorkspace: (id: string) => void;
  refreshMe: () => Promise<Me>;
  logout: () => Promise<void>;
}

const SessionCtx = createContext<SessionState | null>(null);

export function useSession() {
  const v = useContext(SessionCtx);
  if (!v) throw new Error("useSession outside provider");
  return v;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [workspaceId, setWs] = useState(getWorkspaceId());

  const adopt = useCallback((m: Me) => {
    setMe(m);
    const current = getWorkspaceId();
    const valid = m.workspaces.find((w) => w.id === current)?.id ?? m.workspaces[0]?.id ?? "";
    setWorkspaceId(valid);
    setWs(valid);
    return m;
  }, []);

  useEffect(() => {
    api.me().then(adopt, () => setMe(null));
    const out = () => setMe(null);
    window.addEventListener("so:signed-out", out);
    return () => window.removeEventListener("so:signed-out", out);
  }, [adopt]);

  const switchWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    setWs(id);
    window.location.hash = "/";
  }, []);
  const refreshMe = useCallback(() => api.me().then(adopt), [adopt]);
  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
  }, []);

  if (me === undefined) return <div className="auth muted">Loading…</div>;
  if (me === null) return <AuthView onSignedIn={adopt} />;
  if (!workspaceId) return <NoWorkspace refresh={refreshMe} />;
  return (
    <SessionCtx.Provider value={{ me, workspaceId, switchWorkspace, refreshMe, logout }}>
      {/* Remount all workspace state when switching tenants. */}
      <AppProvider key={workspaceId}>{children}</AppProvider>
    </SessionCtx.Provider>
  );
}

function NoWorkspace({ refresh }: { refresh: () => Promise<Me> }) {
  const [name, setName] = useState("My studio");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="auth">
      <div className="auth-card form">
        <h1>Set up a workspace</h1>
        <label className="field">
          <span>New studio</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn primary wide" onClick={() => api.createWorkspace(name, true).then(refresh, (e) => setErr(e.message))}>
          Create studio
        </button>
        <p className="muted small">— or join one —</p>
        <label className="field">
          <span>Invite code</span>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <button className="btn wide" disabled={!code} onClick={() => api.join(code).then(refresh, (e) => setErr(e.message))}>
          Join
        </button>
        {err && <p className="neg small">{err}</p>}
      </div>
    </div>
  );
}

interface AppState {
  boot: Bootstrap | null;
  jobs: JobSummary[];
  stats: FirmStats | null;
  refresh: () => Promise<void>;
  setPolicy: (p: Bootstrap["policy"]) => void;
  toast: (msg: string, kind?: "ok" | "err") => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [stats, setStats] = useState<FirmStats | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: "ok" | "err" }[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const [j, s] = await Promise.all([api.jobs(), api.stats()]);
    setJobs(j);
    setStats(s);
  }, []);

  useEffect(() => {
    api.bootstrap().then(setBoot);
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const toast = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const setPolicy = useCallback((policy: Bootstrap["policy"]) => setBoot((b) => (b ? { ...b, policy } : b)), []);

  return (
    <Ctx.Provider value={{ boot, jobs, stats, refresh, setPolicy, toast }}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

/** Minimal hash router: #/section/a/b */
export function useRoute(): [string[], (path: string) => void] {
  const parse = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((path: string) => {
    window.location.hash = path.startsWith("/") ? path : `/${path}`;
  }, []);
  return [parts, go];
}

export function go(path: string) {
  window.location.hash = path.startsWith("/") ? path : `/${path}`;
}

/** Run an async action with toast-on-error and a busy flag. */
export function useAction() {
  const { toast, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast(ok);
        refresh();
        return r;
      } catch (e) {
        toast((e as Error).message, "err");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, refresh],
  );
  return { busy, run };
}
