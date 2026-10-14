import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Me } from "../shared/types";
import { api } from "./api";
import { App } from "./App";
import { AppProvider } from "./store";
import { AuthView } from "./views/Auth";
import "./styles.css";

function Root() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);
  if (me === undefined) return null;
  if (!me) return <AuthView onIn={setMe} />;
  return (
    <AppProvider me={me} setMe={setMe}>
      <App />
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
