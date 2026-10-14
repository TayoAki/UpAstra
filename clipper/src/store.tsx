import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me } from "../shared/types";
import { api, ApiError, type State } from "./api";

interface Ctx {
  me: Me;
  setMe: (m: Me | null) => void;
  state: State | null;
  setState: (s: State) => void;
  refresh: () => Promise<void>;
  busy: boolean;
  /** Run an action that returns fresh state; shows a toast either way. */
  run: <T,>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;
  toast: (msg: string, bad?: boolean) => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export function AppProvider({ me, setMe, children }: { me: Me; setMe: (m: Me | null) => void; children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const toast = useCallback((text: string, bad = false) => {
    setMsg({ text, bad });
    setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), bad ? 6000 : 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    }
  }, [setMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a render is running, keep its progress fresh.
  const rendering = !!state?.clips.some((c) => c.render && !["done", "failed"].includes(c.render.status));
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [rendering, refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string) => {
      setBusy(true);
      try {
        const r = await fn();
        if (r && typeof r === "object" && "campaigns" in (r as object)) setState(r as unknown as State);
        if (r && typeof r === "object" && "state" in (r as object)) setState((r as unknown as { state: State }).state);
        if (ok) toast(ok);
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        toast((e as Error).message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, setMe],
  );

  return (
    <AppCtx.Provider value={{ me, setMe, state, setState, refresh, busy, run, toast }}>
      {children}
      {msg && <div className={`toast ${msg.bad ? "bad" : ""}`}>{msg.text}</div>}
    </AppCtx.Provider>
  );
}

/** Hash routes: #/, #/new, #/c/:id/:tab, #/review, #/posts, #/settings */
export function useRoute(): [string[], (to: string) => void] {
  const parse = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [parts, (to: string) => (window.location.hash = to)];
}
export const go = (to: string) => (window.location.hash = to);
