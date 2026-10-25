import { useConsole } from "../console";
import { useDocumentTitle } from "../useDocumentTitle";

export function SignedOut() {
  useDocumentTitle("Signed out");
  const { signIn } = useConsole();
  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">You have signed out</h1>
      <p className="text-sm text-text-muted">This tab no longer holds a session for the console.</p>
      <button
        type="button"
        onClick={() => void signIn("/")}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-surface hover:bg-brand-strong"
      >
        Sign in again
      </button>
    </main>
  );
}
