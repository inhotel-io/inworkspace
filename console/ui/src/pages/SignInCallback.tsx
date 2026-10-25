import { useEffect, useRef, useState } from "react";
import { ErrorPanel } from "../components/ErrorPanel";
import { Loading } from "../components/Loading";
import { useConsole } from "../console";

/** The page the server returns to after sign-in. It is outside the hash router, on its own path. */
export function SignInCallback() {
  const { settings, completeSignIn } = useConsole();
  const [error, setError] = useState<string | null>(null);
  // The code can be exchanged once; StrictMode runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    completeSignIn(new URL(window.location.href)).then(
      (returnTo) => window.location.replace(`${settings.basePath}/#${returnTo}`),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [completeSignIn, settings.basePath]);

  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16">
      {error ? (
        <>
          <ErrorPanel title="Sign-in did not finish" detail={error} />
          <a href={`${settings.basePath}/`} className="text-sm font-medium text-brand hover:underline">
            Start again
          </a>
        </>
      ) : (
        <Loading label="Finishing sign-in…" />
      )}
    </main>
  );
}
