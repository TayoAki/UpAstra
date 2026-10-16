import { useState } from "react";
import type { Me } from "../../shared/types";
import { api } from "../api";
import { Logo } from "../components/Logo";
import { hashQuery } from "../store";

type Mode = "login" | "signup" | "forgot" | "reset";

export function AuthView({ onIn, notice }: { onIn: (m: Me) => void; notice?: string }) {
  // A reset link opens this page at #/reset?token=…
  const resetToken = /^#\/reset\b/.test(window.location.hash) ? (hashQuery().get("token") ?? "") : "";
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : "signup");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [info, setInfo] = useState(notice ?? "");
  const [busy, setBusy] = useState(false);
  const switchTo = (m: Mode) => (setMode(m), setErr(""), setInfo(""));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "forgot") {
        await api.forgot(f.email);
        setInfo(`If ${f.email} has an account, a reset link is on its way. It works for 1 hour.`);
        return;
      }
      const m = mode === "signup" ? await api.signup(f) : mode === "reset" ? await api.reset(resetToken, f.password) : await api.login(f.email, f.password);
      if (mode === "reset") window.location.hash = "/";
      onIn(m);
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
          <h1>{{ signup: "Create your account", login: "Welcome back", forgot: "Reset your password", reset: "Choose a new password" }[mode]}</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {{ signup: "Free while in beta.", login: "Sign in to your campaigns.", forgot: "We'll email you a link to choose a new one.", reset: "Then you're signed in. Other devices are signed out." }[mode]}
          </p>
          {mode === "signup" && (
            <label className="field">
              Name
              <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
            </label>
          )}
          {mode !== "reset" && (
            <label className="field">
              Email
              <input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
            </label>
          )}
          {mode !== "forgot" && (
            <label className="field">
              {mode === "reset" ? "New password" : "Password"}
              <input className="input" type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </label>
          )}
          {err && <div className="neg small">{err}</div>}
          {info && <div className="pos small">{info}</div>}
          <button className="btn primary" disabled={busy} style={{ justifyContent: "center", padding: 10 }}>
            {{ signup: "Create account", login: "Sign in", forgot: "Email me a reset link", reset: "Save and sign in" }[mode]}
          </button>
          {mode === "signup" && (
            <p className="small faint" style={{ margin: 0 }}>
              By creating an account you agree to the{" "}
              <a href="#/terms" target="_blank" rel="noreferrer">
                Terms
              </a>{" "}
              and{" "}
              <a href="#/privacy" target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
              .
            </p>
          )}
          {mode === "login" && (
            <button type="button" className="btn ghost" onClick={() => switchTo("forgot")}>
              Forgot your password?
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => switchTo(mode === "signup" ? "login" : mode === "login" ? "signup" : "login")}>
            {mode === "signup" ? "Already have an account? Sign in" : mode === "login" ? "New here? Create an account" : "Back to sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
