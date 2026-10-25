import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createApiClient, type ApiGet } from "./api";
import { beginSignIn, clearTokens, completeSignIn, readTokens, type SessionEnvironment } from "./auth/session";
import type { UiSettings } from "./settings";

interface ConsoleValue {
  settings: UiSettings;
  get: ApiGet;
  hasSession: () => boolean;
  signIn: (returnTo: string) => Promise<void>;
  completeSignIn: (callback: URL) => Promise<string>;
  signOut: () => void;
}

const ConsoleContext = createContext<ConsoleValue | null>(null);

/** One trip to the sign-in page per page load, however many requests find the session ended. */
const signInOnce = (() => {
  let started = false;
  return async (start: () => Promise<string>): Promise<void> => {
    if (started) return;
    started = true;
    try {
      window.location.assign(await start());
    } catch (error) {
      started = false;
      throw error;
    }
  };
})();

/** The app's route, from the hash: "#/events?severity=error" → "/events?severity=error". */
export function routeFromHash(hash: string): string {
  return hash.startsWith("#/") ? hash.slice(1) : "/";
}

function sessionEnvironment(settings: UiSettings): SessionEnvironment {
  return {
    origin: window.location.origin,
    basePath: settings.basePath,
    clientId: settings.clientId,
    store: window.sessionStorage,
    fetch: (input, init) => window.fetch(input, init),
    now: () => Date.now(),
  };
}

export function ConsoleProvider({ settings, children }: { settings: UiSettings; children: ReactNode }) {
  const value = useMemo<ConsoleValue>(() => {
    const session = sessionEnvironment(settings);
    const signIn = (returnTo: string) => signInOnce(() => beginSignIn(session, returnTo));
    return {
      settings,
      get: createApiClient({
        apiUrl: settings.apiUrl,
        session,
        onSessionEnded: () => void signIn(routeFromHash(window.location.hash)),
      }),
      hasSession: () => readTokens(session.store) !== null,
      signIn,
      completeSignIn: (callback) => completeSignIn(session, callback),
      signOut: () => {
        clearTokens(session.store);
        window.location.assign(`${settings.basePath}/#/signed-out`);
      },
    };
  }, [settings]);
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole needs a ConsoleProvider");
  return value;
}
