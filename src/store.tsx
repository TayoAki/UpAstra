import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { FirmStats } from "../shared/types";
import { api, type Bootstrap, type JobSummary } from "./api";

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
