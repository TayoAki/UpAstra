import { useState, type FormEvent } from "react";
import { api, type Me } from "../api";

type Mode = "login" | "signup";

export function AuthView({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const invite = new URLSearchParams(window.location.search).get("invite") ?? "";
  const [mode, setMode] = useState<Mode>(invite ? "signup" : "login");
  const [f, setF] = useState({ email: "", password: "", name: "", workspaceName: "", demo: true, invite });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const me = mode === "login" ? await api.login(f.email, f.password) : await api.signup({ ...f, invite: f.invite || undefined });
      if (f.invite) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      onSignedIn(me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="rail-logo">SO</span>
          <div>
            <strong>Studio Operator</strong>
            <div className="muted small">Run an AI-native creative service firm</div>
          </div>
        </div>
        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>
        <form onSubmit={submit} className="form">
          {mode === "signup" && (
            <label className="field">
              <span>Your name</span>
              <input className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </label>
          {mode === "signup" &&
            (f.invite ? (
              <p className="small muted">You're joining a workspace with invite code {f.invite}.</p>
            ) : (
              <>
                <label className="field">
                  <span>Studio name</span>
                  <input className="input" placeholder="e.g. Northside Creative" value={f.workspaceName} onChange={(e) => setF({ ...f, workspaceName: e.target.value })} />
                </label>
                <label className="radio">
                  <input type="checkbox" checked={f.demo} onChange={(e) => setF({ ...f, demo: e.target.checked })} />
                  Start with demo jobs, clients and radar leads
                </label>
              </>
            ))}
          {error && <p className="neg small">{error}</p>}
          <button className="btn primary wide" disabled={busy}>
            {busy ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
