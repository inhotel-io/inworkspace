"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-text-muted">The page could not be rendered.{error.digest ? ` Reference ${error.digest}.` : ""}</p>
      <button type="button" onClick={reset} className="mt-6 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-surface hover:bg-brand-strong">
        Try again
      </button>
    </main>
  );
}
