import { useState } from "react";
import type { Me } from "../../shared/types";
import { api } from "../api";
import { Logo } from "../components/Logo";

export function AuthView({ onIn }: { onIn: (m: Me) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      onIn(mode === "signup" ? await api.signup(f) : await api.login(f.email, f.password));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-pitch">
        <Logo size={40} />
        <h1>Paste a clipping brief. Get clips that follow every rule.</h1>
        <ul>
          <li>Reads the brief from a Google Doc, link or pasted text: CPM, payout cap, required phrases, CTA and banned claims.</li>
          <li>Pulls the campaign's footage straight from its Drive folders.</li>
          <li>Writes hooks, voiceovers and shot lists, then checks each plan against the brief.</li>
          <li>Tracks every post: views, engagement and what each campaign owes you.</li>
        </ul>
      </div>
      <div className="auth-form">
        <form onSubmit={submit}>
          <h1>{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {mode === "signup" ? "Free while in beta." : "Sign in to your campaigns."}
          </p>
          {mode === "signup" && (
            <label className="field">
              Name
              <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
            </label>
          )}
          <label className="field">
            Email
            <input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
          </label>
          <label className="field">
            Password
            <input className="input" type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
          </label>
          {err && <div className="neg small">{err}</div>}
          <button className="btn primary" disabled={busy} style={{ justifyContent: "center", padding: 10 }}>
            {mode === "signup" ? "Create account" : "Sign in"}
          </button>
          <button type="button" className="btn ghost" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
            {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </form>
      </div>
    </div>
  );
}
