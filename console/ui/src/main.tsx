import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { callbackPath } from "./auth/session";
import { ConsoleProvider } from "./console";
import { SignInCallback } from "./pages/SignInCallback";
import { readSettings } from "./settings";
import "./styles.css";

const settings = readSettings(document);
// The OAuth callback is the app's only real path: everything else lives in the hash, which the
// server never sees, so no route can trip its path checks.
const onCallback = window.location.pathname === callbackPath(settings.basePath);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConsoleProvider settings={settings}>{onCallback ? <SignInCallback /> : <App />}</ConsoleProvider>
  </StrictMode>,
);
