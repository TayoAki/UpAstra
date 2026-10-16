import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Me } from "../shared/types";
import { api } from "./api";
import { App } from "./App";
import { AppProvider, hashQuery } from "./store";
import { AuthView } from "./views/Auth";
import { LegalPage } from "./views/Legal";
import "./styles.css";

const page = () => window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];

function Root() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState(page);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const on = () => setRoute(page());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    // A confirmation link (#/verify?token=…) works signed in or out.
    const token = page() === "verify" ? hashQuery().get("token") : null;
    const confirm = token
      ? api.verifyEmail(token).then(
          (r) => setNotice(`Thanks — ${r.email} is confirmed.`),
          (e: Error) => setNotice(e.message),
        )
      : Promise.resolve();
    void confirm.then(() => {
      if (token) window.location.hash = "/";
      return api.me().then(setMe, () => setMe(null));
    });
  }, []);
  if (route === "terms" || route === "privacy") return <LegalPage kind={route} />;
  if (me === undefined) return null;
  if (!me) return <AuthView onIn={setMe} notice={notice} />;
  return (
    <AppProvider me={me} setMe={setMe}>
      {notice && (
        <div className="flash" role="status">
          {notice}
          <button className="btn sm ghost" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      )}
      <App />
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
